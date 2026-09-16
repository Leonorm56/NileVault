import { mnemonicNew, mnemonicToPrivateKey, mnemonicValidate } from "@ton/crypto";
import {
  Address,
  beginCell,
  Cell,
  contractAddress,
  external,
  fromNano,
  internal,
  storeMessage,
} from "@ton/core";

import Encrypter from "./Encrypter.js";
import { decToRaw, rawToDec } from "./amount.js";
import { isTransferInFlight } from "./sendQueue.js";
import {
  DEFAULT_SEND_MODE,
  DEFAULT_WALLET_PLATFORM,
  FEE_FALLBACK_NANO,
  JETTON_ATTACHED_TON,
  JETTON_ATTACHED_TON_TINY,
  JETTON_FORWARD_TON,
  JETTON_TRANSFER_OP,
  MINTLESS_CLAIM_TON,
  SWEEP_SEND_MODE,
  TRANSFER_TIMEOUT_SEC,
  WALLET_PLATFORMS,
  buildWalletContract,
  commentToCell,
  externalInHashNormalized,
  isExpiredTransferError,
  isSeqnoMismatchError,
  jettonWalletData,
  generateQueryId,
  normalizeWalletPlatform,
  signingPlatformConflict,
  withFeeHeadroom,
} from "./tonStandards.js";

const API_BASE = "https://tonapi.io/v2";
const TONCENTER_BASE = "https://toncenter.com/api/v2";
/** toncenter API v3 — `/walletStates` returns status, balance, seqno and wallet
 *  type for an address (or a batch) in a single response. */
const TONCENTER_V3_BASE = "https://toncenter.com/api/v3";
/** How long a wallet-state snapshot stays usable. Short on purpose: the whole
 *  point of the snapshot is a fresh seqno, and it is skipped entirely while a
 *  transfer is in flight. */
const SNAPSHOT_TTL_MS = 5_000;

/** What an account the chain has never seen looks like. */
const EMPTY_WALLET_STATE = Object.freeze({
  status: "uninit",
  deployed: false,
  balanceNano: 0n,
  seqno: 0,
  walletType: null,
  platform: null,
  interfaces: [],
  isWallet: false,
  memoRequired: false,
  isScam: false,
});

/** address → { at, value }, invalidated by a transfer in flight. */
const snapshotCache = new Map();

const TOKENS_KEY_PREFIX = "account-";
const TOKENS_SUFFIX = ":nile-wallet:tokens";
const WALLET_KEY_PREFIX = "account-";
const WALLET_SUFFIX = ":nile-wallet";

/* ────────────────────────────────────────────────────────────────────────── */
/* Transfer constants                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/*
 * The protocol constants this stack uses live in `tonStandards.js`, one place
 * with the specification each value comes from. The three TEP-74 names are
 * re-exported here because the rest of the app imports them from the wallet.
 */
export {
  FEE_FALLBACK_NANO,
  JETTON_ATTACHED_TON,
  JETTON_ATTACHED_TON_TINY,
  JETTON_FORWARD_TON,
  JETTON_TRANSFER_OP,
  MINTLESS_CLAIM_TON,
  SWEEP_SEND_MODE,
  TRANSFER_TIMEOUT_SEC,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Accept either a parsed `Address` or any string form of a TON address. */
function asAddress(value) {
  return value instanceof Address ? value : Address.parse(String(value));
}

/**
 * TON to attach to a jetton transfer for a given token.
 *
 * TEP-74 expects the sender to fund the jetton wallet's gas, the notification
 * forward and (on the first transfer to a fresh counterparty) the deployment of
 * its jetton wallet. 0.05 TON covers that for a standard jetton; tokens flagged
 * as tiny move less gas and take the smaller attachment. Whatever is not spent
 * comes back to the sender through `response_destination`.
 */
export function jettonAttachedTon(token) {
  return token?.isTiny ? JETTON_ATTACHED_TON_TINY : JETTON_ATTACHED_TON;
}

/**
 * Read the first `num` out of a tonapi run-method response.
 *
 * tonapi returns stack entries as objects (`{ type: "num", num: "0x18703" }`),
 * not the `["num", "0x…"]` tuples the liteserver wire format uses. It also
 * reports a non-zero `exit_code` for some perfectly valid get-method responses,
 * so the value is read from the stack rather than gated on `success`.
 */
function readStackNumber(data) {
  const stack = Array.isArray(data?.stack) ? data.stack : [];
  const entry = stack.find(
    (item) => item && item.type === "num" && typeof item.num === "string",
  );
  if (!entry) return null;
  const parsed = entry.num.startsWith("0x")
    ? Number.parseInt(entry.num, 16)
    : Number(entry.num);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Build a TEP-74 `transfer` body (the message a jetton wallet understands).
 *
 * Layout: `transfer#0f8a7ea5 query_id:uint64 amount:Coins destination:MsgAddress
 * response_destination:MsgAddress custom_payload:(Maybe ^Cell)
 * forward_ton_amount:Coins forward_payload:(Either Cell ^Cell)`.
 *
 * `responseDestination` receives leftover TON, and `forwardTon` is what makes
 * the recipient's own jetton wallet record the incoming balance.
 */
export function buildJettonTransferBody({
  amountRaw,
  destination,
  responseDestination,
  forwardTon = JETTON_FORWARD_TON,
  queryId = 0n,
}) {
  return beginCell()
    .storeUint(JETTON_TRANSFER_OP, 32)
    .storeUint(queryId, 64)
    .storeCoins(BigInt(amountRaw))
    .storeAddress(asAddress(destination))
    .storeAddress(responseDestination ? asAddress(responseDestination) : null)
    .storeBit(0) // custom_payload:(Maybe ^Cell) = absent
    .storeCoins(BigInt(forwardTon))
    .storeBit(0) // forward_payload:(Either Cell ^Cell) = inline empty
    .endCell();
}

/**
 * Sum a `fees` object from toncenter's estimate response.
 *
 * The response nests the fields, so both the source fees of the external
 * message and every destination fee have to be walked — reading the four field
 * names off the top level (which is what this used to do) matches nothing and
 * silently yields no estimate at all.
 *
 *   { result: { source_fees: { in_fwd_fee, storage_fee, gas_fee, fwd_fee },
 *               destination_fees: [ { in_fwd_fee, storage_fee, gas_fee, fwd_fee } ] } }
 */
function sumFeesEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  let total = 0n;
  let seen = false;
  for (const field of ["in_fwd_fee", "storage_fee", "gas_fee", "fwd_fee"]) {
    const value = Number(entry[field]);
    if (Number.isFinite(value)) {
      total += BigInt(Math.trunc(value));
      seen = true;
    }
  }
  return seen ? total : null;
}

function sumFeeFields(result) {
  if (!result || typeof result !== "object") return null;

  const source = sumFeesEntry(result.source_fees ?? result);
  if (source === null) return null;

  let total = source;
  const destinations = Array.isArray(result.destination_fees) ? result.destination_fees : [];
  for (const entry of destinations) {
    const fee = sumFeesEntry(entry?.fees ?? entry);
    if (fee !== null) total += fee;
  }
  return total;
}

/**
 * Best-effort bounce flag for a recipient string.
 *
 * `EQ…` is the bounceable form and `UQ…` the non-bounceable one: the flag is a
 * property of the address the user pasted, so it is read from there rather than
 * assumed. When the value carries no friendly form (a raw `0:…` address) the
 * bounceable reading is used, which is the convention for a wallet address.
 */
function bounceFlagFor(value) {
  try {
    return Address.parseFriendly(String(value)).isBounceable;
  } catch {
    return true;
  }
}

/**
 * Parse a toncenter `/walletStates` response into a map keyed by raw address.
 *
 * One response can describe several addresses, which is what makes a single
 * request enough for a whole list of wallets.
 */
function parseToncenterStates(data) {
  const states = new Map();
  if (!data || !Array.isArray(data.wallets)) return states;

  for (const entry of data.wallets) {
    try {
      const raw = Address.parse(String(entry?.address ?? "")).toRawString().toLowerCase();
      const interfaces = data.address_book?.[entry.address]?.interfaces;
      states.set(raw, {
        ...EMPTY_WALLET_STATE,
        status: entry.status || "uninit",
        deployed: entry.status === "active",
        balanceNano: BigInt(entry.balance ?? 0),
        seqno: Number(entry.seqno ?? 0) || 0,
        walletType: entry.wallet_type || null,
        platform: normalizeWalletPlatform(entry.wallet_type),
        interfaces: Array.isArray(interfaces) ? interfaces : [],
        isWallet: entry.is_wallet === true,
      });
    } catch {
      /* a malformed entry must not lose the rest of the response */
    }
  }
  return states;
}

/**
 * Balances (and deployment state) for several addresses in one request.
 *
 * Used by the picker, which otherwise needs one request per wallet just to show
 * a list of balances. Addresses the indexer does not know come back as empty
 * accounts, and an unreachable or rate-limited indexer yields an empty map so
 * the caller can fall back.
 */
export async function fetchWalletStates(addresses) {
  const wanted = [];
  for (const value of addresses) {
    try {
      wanted.push({ raw: Address.parse(value).toRawString().toLowerCase(), address: value });
    } catch {
      /* skip unparseable input */
    }
  }
  if (!wanted.length) return new Map();

  const url = `${TONCENTER_V3_BASE}/walletStates?address=${encodeURIComponent(
    wanted.map((entry) => entry.address).join(","),
  )}`;

  let states = new Map();
  try {
    const res = await fetch(url);
    if (res.ok) states = parseToncenterStates(await res.json());
  } catch {
    return new Map();
  }

  const out = new Map();
  for (const { raw, address } of wanted) {
    out.set(address, states.get(raw) ?? { ...EMPTY_WALLET_STATE });
  }
  return out;
}

export default class WalletInstance {
  constructor({ storage, accountId }) {
    this.storage = storage;
    this.accountId = accountId;
    this._walletKey = `${WALLET_KEY_PREFIX}${accountId}${WALLET_SUFFIX}`;
    this._tokensKey = `${TOKENS_KEY_PREFIX}${accountId}${TOKENS_SUFFIX}`;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Persistence                                                             */
  /* ──────────────────────────────────────────────────────────────────────── */

  async load() {
    return (await this.storage.get(this._walletKey, null)) || null;
  }

  async save(data) {
    await this.storage.set(this._walletKey, data);
  }

  async clear() {
    await this.storage.remove(this._walletKey);
    await this.storage.remove(this._tokensKey);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Key material                                                            */
  /* ──────────────────────────────────────────────────────────────────────── */

  async generate() {
    const phrase = (await mnemonicNew(24)).join(" ");
    return this.importFromPhrase(phrase);
  }

  /**
   * Derive a wallet from a recovery phrase.
   *
   * The contract version is a parameter, not an assumption: the same 24 words
   * produce a different address under v3, v4 and v5, and a wallet created by
   * another app is very often not the v4 shape this app creates by default. The
   * caller picks the version with {@link detectPlatform} on import; everything
   * else (a wallet generated here, a restore from a backup that recorded its
   * platform) passes the version it already knows.
   */
  async importFromPhrase(phrase, platform = DEFAULT_WALLET_PLATFORM) {
    const words = phrase.trim().split(/\s+/);
    if (words.length !== 24) throw new Error("Recovery phrase must be 24 words");
    const valid = await mnemonicValidate(words);
    if (!valid) throw new Error("Invalid recovery phrase");

    const keyPair = await mnemonicToPrivateKey(words);
    const contract = buildWalletContract(keyPair.publicKey, platform);
    const address = contract.address.toString({ urlSafe: true, bounceable: false });
    const rawAddress = contract.address.toRawString();

    return {
      phrase: words.join(" "),
      address,
      rawAddress,
      platform,
      publicKey: keyPair.publicKey.toString("hex"),
    };
  }

  /**
   * Every address a public key has under the versions this build supports.
   *
   * Used to find where an imported seed's funds actually are: the app cannot ask
   * the user which wallet contract their previous app used, but it can ask the
   * chain which of the candidate addresses exists.
   */
  addressesForPlatforms(publicKey, platforms = WALLET_PLATFORMS) {
    return platforms.map((platform) => {
      const contract = buildWalletContract(publicKey, platform);
      return {
        platform,
        address: contract.address.toString({ urlSafe: true, bounceable: false }),
        rawAddress: contract.address.toRawString(),
      };
    });
  }

  /**
   * Probe the chain for the candidate addresses and return the one that holds
   * the wallet: deployed first, then funded, then the version this app creates.
   *
   * `walletStates` answers for a batch in a single request, and an address the
   * indexer has never seen comes back as an empty entry, so the candidates can
   * all be asked at once instead of one request per version.
   */
  async detectPlatform(publicKey, platforms = WALLET_PLATFORMS) {
    const candidates = this.addressesForPlatforms(publicKey, platforms);
    const batched = await this._json(
      `${TONCENTER_V3_BASE}/walletStates?address=${encodeURIComponent(
        candidates.map((entry) => entry.address).join(","),
      )}`,
    );

    if (batched && Array.isArray(batched.wallets) && batched.wallets.length) {
      const byPlatform = new Map(candidates.map((entry) => [entry.address, entry]));
      let funded = null;
      for (const state of batched.wallets) {
        let matched = null;
        for (const [address, candidate] of byPlatform) {
          try {
            if (this._sameAddress(address, state.address)) matched = candidate;
          } catch {
            /* skip malformed entries */
          }
        }
        if (!matched) continue;
        if (state.status === "active") return { ...matched, deployed: true, balanceNano: BigInt(state.balance ?? 0), source: "toncenter" };
        if (BigInt(state.balance ?? 0) > 0n && !funded) {
          funded = { ...matched, deployed: false, balanceNano: BigInt(state.balance ?? 0), source: "toncenter" };
        }
      }
      if (funded) return funded;
      return { ...candidates.find((c) => c.platform === DEFAULT_WALLET_PLATFORM), deployed: false, balanceNano: 0n, source: "toncenter" };
    }

    // Fallback: one account read per candidate.
    let funded = null;
    for (const candidate of candidates) {
      const snapshot = await this.fetchWalletState(candidate.address);
      if (snapshot.deployed) return { ...candidate, deployed: true, balanceNano: snapshot.balanceNano, source: snapshot.source };
      if (snapshot.balanceNano > 0n && !funded) {
        funded = { ...candidate, deployed: false, balanceNano: snapshot.balanceNano, source: snapshot.source };
      }
    }
    if (funded) return funded;
    return {
      ...candidates.find((c) => c.platform === DEFAULT_WALLET_PLATFORM),
      deployed: false,
      balanceNano: 0n,
      source: "fallback",
    };
  }

  /**
   * True when a jetton master implements the mintless-airdrop extension.
   *
   * A mintless balance lives outside its jetton wallet until it is claimed, so a
   * plain TEP-74 transfer cannot move it — the claim has to ride along in the
   * same message. Detected by asking for the extension's data; a master that
   * does not implement it answers with a non-zero exit code.
   */
  async isMintlessJetton(jettonMaster) {
    const master = asAddress(jettonMaster).toString();
    const data = await this._json(
      `${API_BASE}/blockchain/accounts/${encodeURIComponent(
        master,
      )}/methods/get_mintless_airdrop_data`,
    );
    if (!data) return false;
    if (data.success === true && !data.exit_code) return true;
    return false;
  }

  async encryptSeed(phrase, key) {
    return Encrypter.encryptWithKey({ data: phrase, key });
  }

  async decryptSeed(encrypted, key) {
    return Encrypter.decryptWithKey({ encrypted, key });
  }

  /**
   * Encrypt a recovery phrase for a backup file, returning the ciphertext
   * **string** — not `Encrypter.encryptData`'s `{ encrypted, salt }` wrapper.
   *
   * A backup file carries a single salt for the whole export and passes it back
   * in on restore, so an entry only ever needs the ciphertext. Returning the
   * wrapper wrote `mnemonic_encrypted` as an object, which the restore parser
   * rejects as "missing encrypted mnemonic" — every export the app produced was
   * silently un-restorable. Symmetrical with {@link decryptFromBackup}, which
   * takes that same string.
   */
  async encryptForBackup(phrase, password, salt) {
    const { encrypted } = await Encrypter.encryptData({
      data: phrase,
      password,
      salt,
    });
    return encrypted;
  }

  async decryptFromBackup(encrypted, password, salt) {
    return Encrypter.decryptData({ encrypted, password, salt });
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Chain reads                                                             */
  /* ──────────────────────────────────────────────────────────────────────── */

  /** Best-effort JSON GET that returns null instead of throwing. */
  async _json(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /**
   * toncenter API v3 `/walletStates`: one request, one consistent snapshot.
   *
   * The indexer reports `status`, `balance`, `seqno` and `wallet_type` for the
   * same block, so deployment state and sequence number can never disagree with
   * each other. It also takes a comma-separated list, which lets a caller price
   * several wallets for the cost of one request. An address the indexer has
   * never seen is not an error: it is an empty account, and the empty-state
   * fields are filled in here.
   *
   * Returns `null` (never throws) when the endpoint is unavailable or limited,
   * so the caller can fall back to tonapi.
   */
  async _fetchToncenterSnapshot(target) {
    const url = `${TONCENTER_V3_BASE}/walletStates?address=${encodeURIComponent(target)}`;
    const data = await this._json(url);
    if (!data || !Array.isArray(data.wallets)) return null;

    let raw;
    try {
      raw = Address.parse(target).toRawString().toLowerCase();
    } catch {
      return null;
    }

    return { ...(parseToncenterStates(data).get(raw) ?? EMPTY_WALLET_STATE), source: "toncenter" };
  }

  /**
   * Fallback snapshot: tonapi's account object plus, for a deployed wallet, the
   * `getSeqno` run-method call.
   *
   * Throws when the network itself is unreachable — a transport failure must
   * never be reported to the user as a zero balance.
   */
  async _fetchTonapiSnapshot(target) {
    let res;
    try {
      res = await fetch(`${API_BASE}/accounts/${encodeURIComponent(target)}`);
    } catch {
      throw new Error("Could not reach the TON network");
    }

    // tonapi 404s for an address it has never seen; that is a valid empty
    // account, not an error.
    if (res.status === 404) return { ...EMPTY_WALLET_STATE, source: "tonapi" };
    if (!res.ok) {
      throw new Error(`Balance lookup failed (${res.status})`);
    }

    const data = await res.json();
    const status = data?.status || "uninit";
    const deployed = status === "active";
    const interfaces = Array.isArray(data?.interfaces) ? data.interfaces : [];

    let seqno = 0;
    if (deployed) {
      seqno = (await this._readSeqnoViaRunMethod(target)).seqno;
    }

    return {
      ...EMPTY_WALLET_STATE,
      status,
      deployed,
      balanceNano: BigInt(data?.balance || 0),
      seqno,
      walletType: interfaces.find((name) => normalizeWalletPlatform(name)) || null,
      platform: interfaces.map(normalizeWalletPlatform).find(Boolean) || null,
      interfaces,
      isWallet: Boolean(data?.is_wallet),
      memoRequired: Boolean(data?.memo_required),
      isScam: Boolean(data?.is_scam),
      source: "tonapi",
    };
  }

  /**
   * A consistent view of an account: deployment, balance, sequence number, and
   * what the chain says the contract is.
   *
   * This is the single read the send stack works from. Everything a transfer
   * needs — the seqno it must sign against, whether `stateInit` has to be
   * attached, the balance the funds check compares against, the wallet type to
   * verify before signing — comes out of one snapshot, so two reads can never
   * contradict each other.
   *
   * Snapshots are memoized for a few seconds, but **never** while a transfer is
   * in flight for that address: the whole value of the cache is avoiding repeat
   * reads, and the whole danger of it is reusing a `seqno` that a signature in
   * progress is about to consume.
   */
  async fetchWalletState(address, options = {}) {
    const target = Address.parse(address).toString();

    if (!options.force && !isTransferInFlight(target)) {
      const hit = snapshotCache.get(target);
      if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) {
        return { ...hit.value, cached: true };
      }
    }

    let snapshot = null;
    try {
      snapshot = await this._fetchToncenterSnapshot(target);
    } catch {
      snapshot = null;
    }
    if (!snapshot) snapshot = await this._fetchTonapiSnapshot(target);

    snapshot.needsDeploy = !snapshot.deployed;
    snapshot.address = target;
    snapshot.cached = false;
    snapshotCache.set(target, { at: Date.now(), value: snapshot });
    return snapshot;
  }

  /**
   * Account state: deployment status, exact balance in nano, what the chain says
   * the contract is, and the transfer hints tonapi reports (`memo_required`,
   * `is_scam`) that the send form warns about.
   */
  async getAccountInfo(address) {
    const snapshot = await this.fetchWalletState(address);
    return {
      status: snapshot.status,
      deployed: snapshot.deployed,
      balanceNano: snapshot.balanceNano,
      interfaces: snapshot.interfaces,
      platform: snapshot.platform,
      isWallet: snapshot.isWallet,
      memoRequired: snapshot.memoRequired,
      isScam: snapshot.isScam,
    };
  }

  /** Exact spendable balance in nano. */
  async getBalanceNano(address) {
    const info = await this.getAccountInfo(address);
    return info.balanceNano;
  }

  /** Display balance. */
  async getBalance(address) {
    return fromNano(await this.getBalanceNano(address));
  }

  /**
   * Read the wallet's current sequence number with the retry budget a signing
   * operation needs.
   *
   * Only used on the tonapi path: a deployed wallet there is a separate
   * `getSeqno` run-method call. A wallet that has never been deployed has no
   * code, so the method is not callable and tonapi 404s for it — that genuinely
   * means seqno 0, and the wallet will also need its `stateInit` attached to
   * the first transfer.
   *
   * For a deployed wallet the value **must** resolve. Swallowing every error and
   * returning 0 makes the wallet sign against a stale seqno: the contract
   * rejects the message, nothing is transferred, and no error is ever surfaced.
   */
  async _readSeqnoViaRunMethod(target) {

    const url = `${API_BASE}/blockchain/accounts/${encodeURIComponent(
      target,
    )}/methods/getSeqno`;

    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await fetch(url);
        if (res.status === 404) return { seqno: 0, needsDeploy: true };
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const seqno = readStackNumber(data);
        if (seqno === null) {
          throw new Error(`unexpected response (exit code ${data?.exit_code ?? "?"})`);
        }
        return { seqno, needsDeploy: false };
      } catch (error) {
        lastError = error;
        if (attempt === 0) await sleep(400);
      }
    }

    throw new Error(
      `Could not read the wallet's sequence number (${
        lastError?.message || "network error"
      }). Check your connection and try again.`,
    );
  }

  /**
   * The wallet's sequence number and whether it still has to be deployed.
   *
   * `preloaded` accepts a snapshot the caller already has, so a transfer sign
   * step never re-reads state it read a moment ago.
   */
  async readSeqno(address, preloaded = null) {
    const snapshot = preloaded ?? (await this.fetchWalletState(address));
    return {
      seqno: snapshot.seqno ?? 0,
      needsDeploy: snapshot.needsDeploy ?? !snapshot.deployed,
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Tracked tokens                                                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  async listTokens() {
    return (await this.storage.get(this._tokensKey, [])) || [];
  }

  async addToken(jettonMasterAddress) {
    const addr = Address.parse(jettonMasterAddress);
    const tokens = await this.listTokens();
    if (tokens.some((token) => token.jetton_master_address === addr.toString())) {
      throw new Error("Token already tracked");
    }

    const res = await fetch(`${API_BASE}/jettons/${addr.toString()}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        body.message || body.error || `Token not found (${res.status})`,
      );
    }
    const data = await res.json();
    const meta = data.metadata || data;

    const token = {
      jetton_master_address: addr.toString(),
      name: meta.name || data.name || "Unknown",
      symbol: meta.symbol || data.symbol || "???",
      decimals: Number(meta.decimals ?? data.decimals) || 9,
      icon_url: meta.image || data.image || data.preview || null,
    };

    tokens.push(token);
    await this.storage.set(this._tokensKey, tokens);
    return token;
  }

  async removeToken(jettonMasterAddress) {
    const tokens = await this.listTokens();
    const next = tokens.filter(
      (token) => token.jetton_master_address !== jettonMasterAddress,
    );
    await this.storage.set(this._tokensKey, next);
  }

  /**
   * Compare two addresses regardless of how they are wrapped.
   *
   * Callers hand this either the strings they read from storage or the
   * `Address` objects a get-method decode produced, and the flags a string
   * carries (bounceable / test-only) are not part of a contract's identity —
   * only the workchain and the 256-bit hash are. Coercing through `String()`
   * first keeps an `Address` argument from being fed to `Address.parse`, which
   * takes text and would otherwise reject it.
   */
  _sameAddress(a, b) {
    try {
      const left = a instanceof Address ? a : Address.parse(String(a));
      const right = b instanceof Address ? b : Address.parse(String(b));
      return left.equals(right);
    } catch {
      return false;
    }
  }

  /**
   * Pull an address out of a run-method response stack.
   *
   * Providers disagree on how they encode a cell: tonapi's `cell` field is the
   * hex form of the serialized cell, toncenter's is base64. Both are a full BOC,
   * so it is parsed here rather than trusted as a decoded convenience field.
   */
  _addressFromStack(data) {
    const entry = (Array.isArray(data?.stack) ? data.stack : []).find(
      (item) => item && item.type === "cell" && typeof item.cell === "string",
    );

    if (entry) {
      for (const decode of [
        () => Cell.fromBoc(Buffer.from(entry.cell, "hex"))[0],
        () => Cell.fromBase64(entry.cell),
      ]) {
        try {
          const address = decode().beginParse().loadAddress();
          if (address) return address;
        } catch {
          /* try the next encoding */
        }
      }
    }

    const decoded = data?.decoded?.jetton_wallet_address ?? data?.decoded?.address;
    if (typeof decoded === "string") {
      try {
        return Address.parse(decoded);
      } catch {
        /* fall through */
      }
    }
    return null;
  }

  /** Pull a cell out of a run-method response stack (same encoding caveat). */
  _cellFromStack(data, index = -1) {
    const cells = (Array.isArray(data?.stack) ? data.stack : []).filter(
      (item) => item && item.type === "cell" && typeof item.cell === "string",
    );
    const entry = cells.at(index);
    if (!entry) return null;
    for (const decode of [
      () => Cell.fromBoc(Buffer.from(entry.cell, "hex"))[0],
      () => Cell.fromBase64(entry.cell),
    ]) {
      try {
        return decode();
      } catch {
        /* try the next encoding */
      }
    }
    return null;
  }

  /**
   * The jetton wallet address for an owner, as the jetton master computes it
   * itself (TEP-74 `get_wallet_address`).
   *
   * Asking the master is authoritative and works before the wallet exists — an
   * indexer only knows about wallets it has already seen. toncenter is tried
   * second, and as a last resort the address is derived from the jetton wallet
   * code the master publishes through `get_jetton_data`, which is the same
   * computation performed locally.
   */
  async _deriveJettonWalletAddress(master, owner) {
    const tonapi = await this._json(
      `${API_BASE}/blockchain/accounts/${encodeURIComponent(
        master.toString(),
      )}/methods/get_wallet_address?args=${encodeURIComponent(owner.toString())}`,
    );
    const viaTonapi = this._addressFromStack(tonapi);
    if (viaTonapi) return viaTonapi;

    const viaToncenter = await this._runGetMethodToncenter(master, "get_wallet_address", {
      asSlice: owner,
    });
    const fromToncenter = this._addressFromStack(viaToncenter);
    if (fromToncenter) return fromToncenter;

    const jettonData = await this._json(
      `${API_BASE}/blockchain/accounts/${encodeURIComponent(
        master.toString(),
      )}/methods/get_jetton_data`,
    );
    const code = this._cellFromStack(jettonData, -1);
    if (!code) return null;

    return contractAddress(0, {
      code,
      data: jettonWalletData({ owner, master, code }),
    });
  }

  /** toncenter v2 `runGetMethod`, which takes stack values as base64 slices. */
  async _runGetMethodToncenter(address, method, { asSlice } = {}) {
    const stack = [];
    if (asSlice) {
      stack.push([
        "slice",
        { bytes: beginCell().storeAddress(asSlice).endCell().toBoc().toString("base64") },
      ]);
    }
    try {
      const res = await fetch(`${TONCENTER_BASE}/runGetMethod`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: address.toString(), method, stack }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.result ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the address of *this wallet's* jetton wallet for a master.
   *
   * A TEP-74 transfer is addressed to the sender's own jetton wallet (the
   * contract that actually holds the balance), not to the jetton master and not
   * to the recipient. Getting this address wrong sends the tokens into a
   * contract that is not the owner's wallet, so it is derived from the master
   * and then **verified against the chain**: the resolved contract must report
   * this wallet as its owner and this master as its minter.
   *
   * Nothing is persisted. A cached address that has gone stale — or that was
   * written by an earlier build from a bad resolution — would be silently
   * reused forever, and this is not a value that is safe to be wrong about.
   */
  async resolveJettonWalletAddress(jettonMaster, options = {}) {
    const stored = await this.load();
    if (!stored?.address) throw new Error("No wallet for this account");

    const owner = asAddress(stored.address);
    const master = asAddress(jettonMaster);

    const derived = await this._deriveJettonWalletAddress(master, owner);
    if (!derived) throw new Error("Could not resolve this token's wallet address");

    if (options.verify === false) return derived.toString();

    const snapshot = await this.fetchWalletState(derived.toString());
    if (!snapshot.deployed) return derived.toString();

    const data = await this._json(
      `${API_BASE}/blockchain/accounts/${encodeURIComponent(
        derived.toString(),
      )}/methods/get_wallet_data`,
    );
    const minter = this._addressFromStackAt(data, 2);
    const walletOwner = this._addressFromStackAt(data, 1);

    if (
      (minter && !this._sameAddress(minter, master)) ||
      (walletOwner && !this._sameAddress(walletOwner, owner))
    ) {
      throw new Error(
        "Could not verify this token's wallet address — refusing to transfer to it",
      );
    }

    return derived.toString();
  }

  /**
   * Read the address at a fixed stack position.
   *
   * `get_wallet_data` returns `(balance, owner, minter, code)`, and providers
   * report addresses either as a `slice`/`cell` or as an already-decoded
   * address entry, so all three encodings are accepted.
   */
  _addressFromStackAt(data, index) {
    const stack = Array.isArray(data?.stack) ? data.stack : [];
    const entry = stack[index];
    if (!entry) return null;

    if (entry.type === "address" && typeof entry.address === "string") {
      try {
        return Address.parse(entry.address);
      } catch {
        return null;
      }
    }

    const single = { stack: [entry] };
    return this._addressFromStack(single);
  }

  /**
   * Every jetton this account holds, in one request.
   *
   * tonapi returns all of an account's jetton balances in a single response, so
   * the picker can assemble its whole portfolio from one call per wallet instead
   * of one call per (wallet, token) pair — the difference between a handful of
   * requests and dozens on every poll.
   *
   * Throws when the network is unreachable so an outage cannot be mistaken for
   * "you hold none of these tokens".
   */
  async listJettonBalances() {
    const stored = await this.load();
    if (!stored?.address) throw new Error("No wallet for this account");

    const owner = Address.parse(stored.address).toString();

    let res;
    try {
      res = await fetch(`${API_BASE}/accounts/${encodeURIComponent(owner)}/jettons`);
    } catch {
      throw new Error("Could not reach the TON network");
    }
    if (res.status === 404) return {};
    if (!res.ok) throw new Error(`Token balances lookup failed (${res.status})`);

    const data = await res.json();
    const balances = {};
    for (const entry of data?.balances || data?.jettons || []) {
      const entryMaster = entry?.jetton?.address || entry?.jetton_address;
      if (!entryMaster) continue;
      let master;
      try {
        master = Address.parse(entryMaster).toString();
      } catch {
        continue;
      }
      balances[master] = String(entry?.balance ?? "0");
    }
    return balances;
  }

  /**
   * Exact jetton balance in base units. An account with no entry for the jetton
   * genuinely holds zero.
   */
  async getJettonBalanceNano(jettonMaster) {
    const master = Address.parse(jettonMaster).toString();
    const balances = await this.listJettonBalances();
    return BigInt(balances[master] || 0);
  }

  /** Display-form jetton balance, or null when it cannot be read. */
  async getJettonBalance(jettonMaster) {
    try {
      return (await this.getJettonBalanceNano(jettonMaster)).toString();
    } catch {
      return null;
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /* Transfers                                                              */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Build a transfer into a broadcastable BOC.
   *
   * The wallet contract's `createTransfer` only returns the signed *body*; a
   * broadcast needs a complete external-in message, so the body is wrapped with
   * `external()` + `storeMessage()`. When the account is not deployed yet the
   * wallet's `stateInit` is attached to that same message, which is what makes
   * the first outgoing transfer deploy the wallet.
   *
   * A jetton transfer is addressed to the owner's jetton wallet with a single
   * TEP-74 `transfer` body; a native transfer goes straight to the recipient.
   *
   * Details that matter for a transfer actually landing:
   *  - the `bounce` flag is the recipient's, not a constant. `EQ…` is the
   *    bounceable form and `UQ…` the non-bounceable one, and they mean opposite
   *    things for an account that has no code yet (TON docs, "Message
   *    management → bounce").
   *  - `timeout` is `valid_until`: the wallet contract refuses a message whose
   *    window has closed, so a slow confirmation dialog must not leave a
   *    signature that dies on arrival.
   *  - `query_id` is random per transfer (TEP-74): it keeps two transfers to the
   *    same destination distinguishable and gives a re-broadcast of the same
   *    message an identity of its own.
   *  - everything is signed against one snapshot of the wallet state, so the
   *    `seqno` in the message and the deployment decision are consistent.
   */
  async buildTransferRequest({
    contract,
    keyPair,
    to,
    amountRaw,
    jetton,
    comment,
    sendMode,
    sweep = false,
    isBounceable,
    timeout,
    snapshot,
    platform,
  }) {
    const destination = asAddress(to);
    const state =
      snapshot ?? (await this.fetchWalletState(contract.address.toString()));

    // The contract that signs has to be the contract that is deployed. A wallet
    // whose record names one version while the chain reports another would sign
    // a valid message the contract then rejects, so this is checked against the
    // same snapshot the `seqno` comes from, before anything is signed.
    const conflict = signingPlatformConflict(platform ?? null, state.platform ?? null);
    if (conflict) throw new Error(conflict);

    const seqno = state.seqno ?? 0;
    const needsDeploy = state.needsDeploy ?? !state.deployed;

    // Messages must be `MessageRelaxed` objects — the wallet contract
    // serializes them with `storeMessageRelaxed`, which reads `message.info`.
    // Passing a bare `{ to, value, body }` throws before anything is signed.
    let message;
    let attachedNano = 0n;
    if (jetton) {
      if (!jetton.jetton_wallet_address) {
        throw new Error("Could not resolve this token's wallet address");
      }
      attachedNano = jetton.attachedNano
        ? BigInt(jetton.attachedNano)
        : jettonAttachedTon(jetton);
      message = internal({
        // A jetton wallet is a contract, so this hop stays bounceable whatever
        // the address form says.
        to: asAddress(jetton.jetton_wallet_address),
        value: attachedNano,
        bounce: true,
        init: jetton.stateInit,
        body: buildJettonTransferBody({
          amountRaw,
          destination,
          responseDestination: contract.address,
          queryId: generateQueryId(),
        }),
      });
    } else {
      message = internal({
        to: destination,
        value: BigInt(amountRaw),
        bounce: isBounceable ?? bounceFlagFor(to),
        body: comment ? commentToCell(comment) : beginCell().endCell(),
      });
    }

    const effectiveSendMode =
      sendMode ?? (sweep ? SWEEP_SEND_MODE : DEFAULT_SEND_MODE);

    const body = contract.createTransfer({
      seqno,
      secretKey: keyPair.secretKey,
      sendMode: effectiveSendMode,
      messages: [message],
      timeout: timeout ?? Math.floor(Date.now() / 1000) + TRANSFER_TIMEOUT_SEC,
    });

    const externalMessage = external({
      to: contract.address,
      init: needsDeploy ? contract.init : undefined,
      body,
    });

    const externalCell = beginCell().store(storeMessage(externalMessage)).endCell();

    return {
      boc: externalCell.toBoc().toString("base64"),
      /** The signed wallet body — the `body` field toncenter's fee estimate wants. */
      bodyBoc: body.toBoc().toString("base64"),
      seqno,
      needsDeploy,
      sendMode: effectiveSendMode,
      attachedNano,
      isBounceable: jetton ? true : (isBounceable ?? bounceFlagFor(to)),
      /** Message identity as indexers compute it (no `state_init`). */
      msgHashNormalized: externalInHashNormalized({ to: contract.address, body }),
      /** Identity of the exact cell being broadcast, `state_init` included. */
      messageId: externalCell.hash().toString("hex"),
      address: contract.address.toString(),
      platform: state.platform ?? null,
      walletType: state.walletType ?? null,
    };
  }

  /**
   * Init code and data for the wallet's own deployment, for the fee estimate.
   * Only meaningful for a wallet that is not deployed yet.
   */
  _initCells(contract, needsDeploy) {
    if (!needsDeploy || !contract?.init) return { code: null, data: null };
    return {
      code: contract.init.code.toBoc().toString("base64"),
      data: contract.init.data.toBoc().toString("base64"),
    };
  }

  /**
   * Live fee estimate for a built transfer.
   *
   * toncenter v2 `/estimateFee` takes the *unsigned* body together with the
   * account address and (for an account that is not deployed) its init code and
   * data; `ignore_chksig` stands in for the signature that does not exist yet.
   * Posting a whole external message to it — which is what this used to do —
   * fails the `address` field check and returns an error, so the live path never
   * ran and every send fell back to a constant.
   *
   * Returns `{ feeNano, estimated, source }`. `estimated: true` means the value
   * is the flat constant rather than a measurement of this transfer; the UI
   * prefixes it with `~` and the funds check still uses it (a bound is better
   * than nothing), but it is never presented as exact.
   *
   * The estimate carries {@link FEE_HEADROOM_PERCENT} of headroom: gas prices
   * move between the estimate and the block, and a requirement that is a few
   * nano short turns into a failed send.
   */
  async estimateTransferFee({ request, contract, isJetton = false }) {
    const needsDeploy = Boolean(request?.needsDeploy);
    const { code, data } = this._initCells(contract, needsDeploy);

    const body = request?.bodyBoc ?? request?.boc;
    const address = request?.address ?? contract?.address?.toString();

    if (body && address) {
      try {
        const res = await fetch(`${TONCENTER_BASE}/estimateFee`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address,
            body,
            init_code: code || undefined,
            init_data: data || undefined,
            ignore_chksig: true,
          }),
        });
        if (res.ok) {
          const payload = await res.json();
          const total = sumFeeFields(payload?.result);
          if (total !== null && total > 0n) {
            return {
              feeNano: withFeeHeadroom(total),
              measuredNano: total,
              estimated: false,
              source: "toncenter",
            };
          }
        }
      } catch {
        /* fall through to the flagged flat estimate */
      }
    }

    return {
      feeNano: withFeeHeadroom(FEE_FALLBACK_NANO),
      measuredNano: null,
      estimated: true,
      source: "fallback",
      isJetton,
    };
  }

  /**
   * Pre-flight both sides of a transfer.
   *
   * Each requirement is counted once:
   *  - a native send needs the amount plus the network fee;
   *  - a native *sweep* needs only the network fee, because the message carries
   *    the whole balance and the fee comes out of the carried value;
   *  - a jetton send needs the jetton balance for the amount, and enough TON for
   *    the value attached to the transfer plus the network fee.
   *
   * The attached value used to be added to the fee requirement as well, so a
   * jetton send demanded the attachment twice — roughly 0.08 TON of idling TON
   * for a transfer whose real cost is a fraction of that.
   */
  async checkTransferFunds({
    contract,
    amountRaw,
    jetton,
    feeNano,
    attachedNano,
    snapshot,
    sweep = false,
  }) {
    const owner = contract.address.toString();
    const state = snapshot ?? (await this.fetchWalletState(owner));
    const tonBalanceNano = state.balanceNano;
    const fee = BigInt(feeNano ?? FEE_FALLBACK_NANO);
    const needed = BigInt(amountRaw);

    if (jetton) {
      const jettonBalanceNano = await this.getJettonBalanceNano(
        jetton.jetton_master_address,
      );
      if (needed > jettonBalanceNano) {
        return {
          sufficient: false,
          reason: `Not enough ${jetton.symbol || "tokens"} — you have ${rawToDec(
            jettonBalanceNano,
            Number(jetton.decimals) || 9,
          )}`,
          tonBalanceNano,
          jettonBalanceNano,
          requiredNano: needed,
          requiredTonNano: BigInt(attachedNano ?? 0n) + fee,
        };
      }
      const gasNeeded = BigInt(attachedNano ?? jettonAttachedTon(jetton)) + fee;
      if (tonBalanceNano < gasNeeded) {
        return {
          sufficient: false,
          reason: `Not enough TON to cover the network fee — ${rawToDec(
            gasNeeded,
            9,
          )} TON needed`,
          tonBalanceNano,
          jettonBalanceNano,
          requiredNano: needed,
          requiredTonNano: gasNeeded,
        };
      }
      return {
        sufficient: true,
        tonBalanceNano,
        jettonBalanceNano,
        requiredNano: needed,
        requiredTonNano: gasNeeded,
      };
    }

    const totalNeeded = sweep ? fee : needed + fee;
    if (tonBalanceNano < totalNeeded) {
      return {
        sufficient: false,
        reason: `Not enough TON — ${rawToDec(
          totalNeeded,
          9,
        )} TON needed, you have ${rawToDec(tonBalanceNano, 9)}`,
        tonBalanceNano,
        jettonBalanceNano: null,
        requiredNano: totalNeeded,
        requiredTonNano: totalNeeded,
      };
    }
    return {
      sufficient: true,
      tonBalanceNano,
      jettonBalanceNano: null,
      requiredNano: totalNeeded,
      requiredTonNano: totalNeeded,
    };
  }

  /** Push a serialized external-in message to the network. */
  async broadcastTransfer(boc) {
    let res;
    try {
      res = await fetch(`${API_BASE}/blockchain/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boc }),
      });
    } catch {
      throw new Error("Could not reach the TON network to broadcast the transfer");
    }

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      /*
       * tonapi may return `accepted: false` for messages that were ingested
       * but rejected by validators (stale seqno, malformed body, etc.). Surfacing
       * that here — otherwise we hand back a hash and the UI reports "Sent!",
       * while the message is silently dropped on the way to a block.
       */
      if (data.accepted === false) {
        const reason = data.error || "The network did not accept the message";
        throw new Error(`Broadcast failed: ${reason}`);
      }
      /*
       * Prefer tonapi's `message_hash` — it is the identity the indexer uses for
       * this message. The fallback is the hash of the exact cell we broadcast
       * (`state_init` included), which is the same value on-chain; the
       * state_init-free form travels separately as `msgHashNormalized`.
       */
      const hash =
        data.message_hash || Cell.fromBase64(boc).hash().toString("hex");
      return { hash, accepted: true };
    }

    const detail = await res.json().catch(() => null);
    const detailText = detail?.error || detail?.message || "";
    if (isSeqnoMismatchError(detailText) || isExpiredTransferError(detailText)) {
      throw new Error(
        "The network rejected the transfer because the wallet's sequence number moved — try again.",
      );
    }
    throw new Error(
      detailText
        ? `The network rejected the transfer: ${detailText}`
        : `Broadcast failed (${res.status})`,
    );
  }

  /** Delivery status of a broadcast message. */
  async getMessageStatus(hash) {
    const data = await this._json(
      `${API_BASE}/blockchain/messages/${encodeURIComponent(hash)}`,
    );
    if (!data) return "unknown";
    if (data.error) return "failed";
    if (data.in_progress === true) return "pending";
    return "completed";
  }

  /**
   * Watch a broadcast transfer until it lands, with a bounded budget.
   *
   * The signal is the wallet's own `seqno`: the contract increments it only
   * after it has executed the message, so "the seqno moved past 7" is proof that
   * the transfer was accepted — stronger than "a message with this hash is not
   * marked in-progress". A message that never gets executed leaves the seqno
   * where it was, which is exactly the state that must be reported as `pending`
   * rather than as a success.
   *
   * Returns `"confirmed"`, `"failed"`, or `"pending"` rather than throwing, so
   * the caller can keep the message id on screen (and on the explorer) in every
   * case — including a transfer that was accepted but is still settling.
   */
  async waitForConfirmation(hash, { seqno, address, waitMs = 60_000, intervalMs = 1_000 } = {}) {
    const deadline = Date.now() + waitMs;

    while (Date.now() < deadline) {
      if (address !== undefined && seqno !== undefined) {
        const state = await this._json(
          `${TONCENTER_V3_BASE}/walletStates?address=${encodeURIComponent(
            Address.parse(address).toString(),
          )}`,
        ).catch(() => null);
        const current = this._seqnoFromToncenterState(state, address);
        if (current !== null && current > seqno) return "confirmed";
      }

      const status = await this.getMessageStatus(hash);
      if (status === "failed") return "failed";

      // With no seqno to compare against, the message status is all there is.
      if (seqno === undefined && status === "completed") return "confirmed";

      await sleep(intervalMs);
    }

    return "pending";
  }

  /** Sequence number out of a toncenter `/walletStates` response, if present. */
  _seqnoFromToncenterState(data, address) {
    const wallets = Array.isArray(data?.wallets) ? data.wallets : [];
    let raw = null;
    try {
      raw = Address.parse(address).toRawString().toLowerCase();
    } catch {
      return null;
    }
    for (const entry of wallets) {
      try {
        if (
          Address.parse(String(entry?.address ?? "")).toRawString().toLowerCase() === raw &&
          Number.isFinite(Number(entry?.seqno))
        ) {
          return Number(entry.seqno);
        }
      } catch {
        /* skip malformed entries */
      }
    }
    return null;
  }
}

/** Parse a decimal amount string into base units (re-exported for the stack). */
WalletInstance.decToRaw = decToRaw;
