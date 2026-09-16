import { Address, fromNano } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { Buffer } from "buffer";

import Encrypter from "./Encrypter.js";
import WalletInstance, {
  fetchWalletStates,
  jettonAttachedTon,
} from "./WalletInstance.js";
import { decToRaw, rawToDec } from "./amount.js";
import {
  clearTransferInFlight,
  markTransferInFlight,
  withoutTransferConcurrency,
} from "./sendQueue.js";
import {
  DEFAULT_WALLET_PLATFORM,
  WALLET_PLATFORMS,
  buildWalletContract,
} from "./tonStandards.js";
import storage from "./storage.js";

/**
 * Client-side NileWallet — runs entirely in the Electron renderer.
 *
 * This is a port of the NileChain extension's `nileWallet.js`. The extension
 * ran the vault/wallet/token/transfer stack client-side and only pushed TON
 * Connect to its service worker (because the popup was ephemeral). NileVault's
 * BrowserWindow is persistent, so everything — including TON Connect — runs
 * here; `nileWalletConnectManager.js` hosts the bridge instances and reuses the
 * same in-memory vault key via {@link getKeyPair}.
 *
 * The seed material is encrypted with a raw AES-GCM key derived once from the
 * single vault passphrase; that key (`vaultKey`) lives only in this module's
 * memory and is cleared on lock / lost on app restart.
 */

const VAULT_STORAGE_KEY = "shared:nile-wallet:vault";
const VAULT_CHECK_PLAINTEXT = "nile-vault-ok";
/** Minimum length enforced on a backup export password. */
export const MIN_BACKUP_PASSWORD_LENGTH = 8;
/**
 * The picker registry. Repointed from the extension's `shared:accounts`
 * (owned by the NileChain core) to a NileVault-owned key, since NileVault owns
 * wallet lifecycle here. Entries: `{ id, name, created }`.
 */
const ACCOUNTS_STORAGE_KEY = "nilevault:wallets";
const BACKUP_VERSION = 1;
const BACKUP_CHAIN = "mainnet";

let vaultKey = null;
const walletCache = new Map();

export function getWallet(accountId) {
  if (!walletCache.has(accountId)) {
    walletCache.set(accountId, new WalletInstance({ storage, accountId }));
  }
  return walletCache.get(accountId);
}

async function getVaultConfig() {
  return await storage.get(VAULT_STORAGE_KEY, null);
}

/**
 * Build the wallet's contract from its *public* key alone.
 *
 * The public key is stored in plaintext (the picker renders before the vault is
 * unlocked), which is enough to know the address and to price a transfer. This
 * is what lets validation and fee estimation run without the seed — the old
 * flow decrypted the mnemonic just to parse an address, so typing anything into
 * the send form demanded an unlock.
 */
/**
 * The contract version a wallet record was created with.
 *
 * Records written before the version was stored are v4r2 by definition — that
 * was the only version this app could create.
 */
function platformOf(stored) {
  return stored?.platform || DEFAULT_WALLET_PLATFORM;
}

async function loadPublicContract(accountId) {
  const wallet = getWallet(accountId);
  const stored = await wallet.load();
  if (!stored?.publicKey) throw new Error("No wallet for this account");
  const contract = buildWalletContract(
    Buffer.from(stored.publicKey, "hex"),
    platformOf(stored),
  );
  return { wallet, stored, contract };
}

function requireKey() {
  if (!vaultKey) throw new Error("needs-unlock");
  return vaultKey;
}

async function unlockVault(password) {
  if (!password) throw new Error("Passphrase required");

  let config = await getVaultConfig();

  if (!config) {
    const salt = Encrypter.generateSalt();
    const key = await Encrypter.scryptPass(password, salt);
    const check = await Encrypter.encryptWithKey({
      data: VAULT_CHECK_PLAINTEXT,
      key,
    });
    await storage.set(VAULT_STORAGE_KEY, { salt, check });
    vaultKey = key;
    return { configured: true, unlocked: true, created: true };
  }

  const key = await Encrypter.scryptPass(password, config.salt);
  try {
    const decrypted = await Encrypter.decryptWithKey({
      encrypted: config.check,
      key,
    });
    if (decrypted !== VAULT_CHECK_PLAINTEXT) throw new Error("mismatch");
  } catch {
    throw new Error("bad-passphrase");
  }

  vaultKey = key;
  return { configured: true, unlocked: true, created: false };
}

/**
 * Decrypt the account's mnemonic (requires unlock) and derive its keypair.
 * Exported so the TON Connect manager can attach signing keys to a connect
 * instance while sharing this module's single in-memory vault key.
 */
export async function getKeyPair(accountId) {
  const key = requireKey();
  const wallet = getWallet(accountId);
  const stored = await wallet.load();

  if (!stored?.encrypted) throw new Error("No wallet for this account");

  const phrase = await wallet.decryptSeed(stored.encrypted, key);
  const keyPair = await mnemonicToPrivateKey(phrase.split(" "));
  const platform = platformOf(stored);
  const contract = buildWalletContract(keyPair.publicKey, platform);

  return { keyPair, phrase, contract, platform };
}

/**
 * Validate a transfer request and resolve everything the signing step needs.
 *
 * The recipient's *form* is kept: `Address.parseFriendly` reports whether the
 * user pasted the bounceable (`EQ…`) or non-bounceable (`UQ…`) encoding, and on
 * an account that has no code yet those two behave in opposite ways (TON docs,
 * "Message management → bounce"). Collapsing both into one normalized string
 * before the send stack sees it — which is what the UI used to do — throws that
 * choice away. A raw `0:…` address carries no flag, so the bounceable reading is
 * used.
 *
 * The jetton wallet address is resolved here, from the master, rather than read
 * off the token record: it is the contract a TEP-74 transfer must target, and a
 * stored copy can be stale.
 */
async function resolveSendParams(wallet, message) {
  const { kind, token, to, amount, comment, sweep } = message;

  const recipient = String(to || "").trim();
  if (!recipient) throw new Error("Enter a recipient address");

  let parsed;
  try {
    parsed = Address.parseFriendly(recipient);
  } catch {
    let address;
    try {
      address = Address.parse(recipient);
    } catch {
      throw new Error("Enter a valid TON address (EQ… or UQ…)");
    }
    parsed = { address, isBounceable: true, isTestOnly: false };
  }

  // A testnet address has the same hash as its mainnet twin, so accepting one
  // silently sends real funds to the mainnet account at that hash.
  if (parsed.isTestOnly) {
    throw new Error(
      "That is a testnet address. NileVault works on mainnet, and the same hash exists there — use the mainnet address.",
    );
  }

  if (!amount || !String(amount).trim()) throw new Error("Enter an amount");

  let raw;
  let jetton = null;
  if (kind === "jetton") {
    if (!token?.jetton_master_address) throw new Error("Choose a token to send");
    const decimals = Number(token.decimals) || 9;
    raw = decToRaw(amount, decimals);
    const jettonWalletAddress = await wallet.resolveJettonWalletAddress(
      token.jetton_master_address,
    );
    jetton = {
      ...token,
      jetton_wallet_address: jettonWalletAddress,
      attachedNano: jettonAttachedTon(token).toString(),
    };
  } else {
    raw = decToRaw(amount, 9);
  }

  if (raw <= 0n) throw new Error("Amount must be greater than zero");

  return {
    to: parsed.address.toString(),
    typed: recipient,
    isBounceable: parsed.isBounceable,
    raw,
    jetton,
    comment: kind === "jetton" ? "" : String(comment ?? "").trim(),
    sweep: kind === "ton" && sweep === true,
  };
}

/**
 * Refuse a bounceable transfer to an account that has no code yet.
 *
 * A bounceable message to an account that does not exist is returned to the
 * sender, so the recipient never sees the money and the sender only loses fees.
 * The recipient's own form is the escape hatch: `UQ…` asks for exactly that
 * behaviour deliberately, which is why receive screens show `UQ…`.
 *
 * Returns the recipient's snapshot so the caller can surface transfer hints
 * (`memo_required`, scam flags) without a second read.
 */
async function checkDestination(wallet, params) {
  if (params.jetton) return null; // the jetton wallet is a deployed contract
  if (!params.isBounceable) return null; // an explicit non-bounceable request

  const snapshot = await wallet.fetchWalletState(params.to);
  if (!snapshot.deployed) {
    throw new Error(
      "That address has no code on-chain yet, so a bounceable transfer would be returned to you. If you are sure it is correct, send to its non-bounceable (UQ…) form instead.",
    );
  }
  return snapshot;
}

/**
 * Price a transfer and check the funds, without the seed.
 *
 * The serialized message is signed with a throwaway key purely so its size —
 * and therefore its fee — matches what will really be broadcast. That BOC is
 * never sent anywhere. The sender's state comes from one snapshot, and the
 * recipient's is read once here so the form can warn before the confirm dialog.
 */
async function handleTransferEstimate(accountId, message) {
  const { wallet, stored, contract } = await loadPublicContract(accountId);
  const params = await resolveSendParams(wallet, message);
  const destination = await checkDestination(wallet, params);

  const snapshot = await wallet.fetchWalletState(contract.address.toString());

  const request = await wallet.buildTransferRequest({
    contract,
    keyPair: { secretKey: Buffer.alloc(64) },
    to: params.to,
    amountRaw: params.raw,
    jetton: params.jetton,
    comment: params.comment,
    isBounceable: params.isBounceable,
    sweep: params.sweep,
    snapshot,
    platform: platformOf(stored),
  });

  const { feeNano, estimated, source } = await wallet.estimateTransferFee({
    request,
    contract,
    isJetton: Boolean(params.jetton),
  });

  const funds = await wallet.checkTransferFunds({
    contract,
    amountRaw: params.raw,
    jetton: params.jetton,
    feeNano,
    attachedNano: request.attachedNano,
    snapshot,
    sweep: params.sweep,
  });

  return {
    status: true,
    to: params.to,
    amountRaw: params.raw.toString(),
    feeNano: feeNano.toString(),
    feeEstimated: estimated,
    feeSource: source,
    attachedNano: request.attachedNano.toString(),
    /*
     * The contract a jetton transfer is actually addressed to. It is not the
     * recipient and not the token: it is the sender's own jetton wallet, the
     * contract holding the balance. Surfacing it lets the confirmation show
     * which contract is being paid before anything is signed — the one value in
     * a TEP-74 send that is derived rather than typed.
     */
    jettonWallet: params.jetton?.jetton_wallet_address ?? null,
    jettonMaster: params.jetton?.jetton_master_address ?? null,
    insufficient: funds.sufficient ? null : funds.reason,
    tonBalanceRaw: funds.tonBalanceNano.toString(),
    jettonBalanceRaw:
      funds.jettonBalanceNano === null || funds.jettonBalanceNano === undefined
        ? null
        : funds.jettonBalanceNano.toString(),
    needsDeploy: request.needsDeploy,
    sendMode: request.sendMode,
    isBounceable: request.isBounceable,
    sweep: params.sweep,
    // Hints about the recipient, read from the same request cycle.
    memoRequired: Boolean(destination?.memoRequired),
    recipientScam: Boolean(destination?.isScam),
    // What the chain says the *sender's* contract is, against what is signing.
    walletType: request.walletType,
    platform: request.platform,
  };
}

/**
 * Listeners for the outcome of an already-broadcast transfer.
 *
 * The send call returns as soon as the network accepts the message; the
 * seqno-advance confirmation finishes later and publishes here, so the screen
 * that started the transfer can update itself instead of holding the whole
 * request open for up to a minute.
 */
const transferListeners = new Set();

export function onTransferSettled(callback) {
  transferListeners.add(callback);
  return () => transferListeners.delete(callback);
}

function emitTransferSettled(payload) {
  for (const callback of [...transferListeners]) {
    try {
      callback(payload);
    } catch {
      /* a broken listener must not break the transfer */
    }
  }
}

/**
 * Sign and broadcast a transfer.
 *
 * Two properties are load-bearing here:
 *
 *  1. The whole build → sign → broadcast sequence runs inside the per-wallet
 *     send queue, and the sender's state is read *after* the in-flight mark is
 *     set, so the `seqno` that gets signed is never one a concurrent send (the
 *     form, another window, a TON Connect request) is also about to consume.
 *     Two signatures against the same `seqno` cannot both land, and the loser is
 *     dropped by validators without any error reaching the app.
 *
 *  2. Confirmation is not awaited. The wallet's `seqno` advancing is the proof
 *     that the message was executed, and watching for it takes as long as the
 *     chain takes (up to a minute). The caller gets the message id immediately;
 *     the outcome arrives through {@link onTransferSettled}.
 */
async function handleTransferSend(accountId, message) {
  const wallet = getWallet(accountId);
  const { contract, keyPair, platform } = await getKeyPair(accountId);
  const params = await resolveSendParams(wallet, message);
  await checkDestination(wallet, params);

  const address = contract.address.toString();

  return withoutTransferConcurrency(address, async (keepAlive) => {
    markTransferInFlight(address);
    let handedOff = false;

    try {
      // Read after the in-flight mark: the snapshot is fresh even if an estimate
      // ran a moment ago.
      const snapshot = await wallet.fetchWalletState(address);

      const request = await wallet.buildTransferRequest({
        contract,
        keyPair,
        to: params.to,
        amountRaw: params.raw,
        jetton: params.jetton,
        comment: params.comment,
        isBounceable: params.isBounceable,
        sweep: params.sweep,
        snapshot,
        platform,
      });

      /*
       * Fee + funds checks belong here too, but they are read-only and never
       * touch the wallet — no key, no signing.
       */
      const { feeNano, estimated, source } = await wallet.estimateTransferFee({
        request,
        contract,
        isJetton: Boolean(params.jetton),
      });

      const funds = await wallet.checkTransferFunds({
        contract,
        amountRaw: params.raw,
        jetton: params.jetton,
        feeNano,
        attachedNano: request.attachedNano,
        snapshot,
        sweep: params.sweep,
      });
      if (!funds.sufficient) throw new Error(funds.reason);

      const { hash } = await wallet.broadcastTransfer(request.boc);

      /*
       * Watch for the message to land on-chain, in the background. A `pending`
       * outcome after the poll budget means the network accepted the BOC but the
       * wallet never executed it — typically a stale seqno, a malformed body or
       * insufficient gas. Reporting that is the difference between "sent" and
       * "sent and executed".
       */
      keepAlive(
        (async () => {
          let txStatus = "unknown";
          try {
            txStatus = await wallet.waitForConfirmation(hash, {
              seqno: request.seqno,
              address,
            });
          } finally {
            clearTransferInFlight(address);
            emitTransferSettled({
              accountId,
              hash,
              msgHashNormalized: request.msgHashNormalized,
              txStatus,
            });
          }
        })(),
      );
      handedOff = true;

      return {
        status: true,
        hash,
        msgHashNormalized: request.msgHashNormalized,
        messageId: request.messageId,
        /** The message is accepted; the on-chain outcome follows. */
        txStatus: "broadcast",
        seqno: request.seqno,
        feeNano: feeNano.toString(),
        feeEstimated: estimated,
        feeSource: source,
        attachedNano: request.attachedNano.toString(),
        needsDeploy: request.needsDeploy,
        to: params.to,
        amountRaw: params.raw.toString(),
        symbol: params.jetton?.symbol || "TON",
        comment: params.comment,
      };
    } finally {
      if (!handedOff) clearTransferInFlight(address);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Wallet registry (the picker's list of NileWallet instances)                 */
/* -------------------------------------------------------------------------- */

/**
 * Address, deployment state and balance for every wallet in the registry.
 *
 * The balances come from a single batched wallet-state request rather than one
 * request per wallet. If that index is unavailable the per-wallet path (which
 * falls back to tonapi) is used instead, so an outage degrades to more requests
 * rather than to a picker full of dashes.
 */
async function walletOverview() {
  const wallets = await listWallets();
  const rows = [];
  for (const entry of wallets) {
    const stored = await getWallet(entry.id).load();
    rows.push({
      id: entry.id,
      address: stored?.address || null,
      hasWallet: Boolean(stored?.encrypted),
    });
  }

  const addresses = rows.filter((row) => row.address).map((row) => row.address);
  let states = addresses.length ? await fetchWalletStates(addresses) : new Map();

  if (addresses.length && states.size === 0) {
    states = new Map();
    for (const row of rows) {
      if (!row.address) continue;
      try {
        states.set(row.address, await getWallet(row.id).fetchWalletState(row.address));
      } catch {
        /* leave this wallet without a state; the UI shows it as unread */
      }
    }
  }

  return rows.map((row) => {
    const state = row.address ? states.get(row.address) : null;
    return {
      id: row.id,
      address: row.address,
      hasWallet: row.hasWallet,
      deployed: state ? state.deployed : null,
      balanceNano: state ? state.balanceNano.toString() : null,
      error: row.address && !state ? "unavailable" : null,
    };
  });
}

/** Read the picker registry: `[{ id, name, created }]`. */
async function listWallets() {
  const wallets = await storage.get(ACCOUNTS_STORAGE_KEY, []);
  return Array.isArray(wallets) ? wallets : [];
}

/** Create a new (empty) NileWallet instance — seed is generated in-wallet. */
async function createWallet(name) {
  const wallets = await listWallets();
  const entry = {
    id: crypto.randomUUID(),
    name: String(name || "").trim() || "Wallet",
    created: Date.now(),
  };
  wallets.push(entry);
  await storage.set(ACCOUNTS_STORAGE_KEY, wallets);
  return { status: true, wallet: entry };
}

/** Rename a wallet in the registry. */
async function renameWallet(id, name) {
  const wallets = await listWallets();
  const idx = wallets.findIndex((w) => w.id === id);
  if (idx === -1) throw new Error("Wallet not found");
  wallets[idx] = {
    ...wallets[idx],
    name: String(name || "").trim() || wallets[idx].name,
  };
  await storage.set(ACCOUNTS_STORAGE_KEY, wallets);
  return { status: true, wallet: wallets[idx] };
}

/**
 * Remove a wallet from the registry and delete all of its stored data
 * (metadata + encrypted seed, tokens, TON Connect sessions). Distinct from
 * the in-wallet "empty this wallet" danger action, which only clears the seed.
 */
async function deleteWallet(id) {
  const wallets = await listWallets();
  const next = wallets.filter((w) => w.id !== id);
  await storage.set(ACCOUNTS_STORAGE_KEY, next);

  const wallet = getWallet(id);
  await wallet.clear(); // account-<id>:nile-wallet + :sessions
  await storage.remove(`account-${id}:nile-wallet:tokens`);
  walletCache.delete(id);

  return { status: true };
}

/* -------------------------------------------------------------------------- */
/* Change passphrase (net-new — the reference has no in-app change flow)        */
/* -------------------------------------------------------------------------- */

/**
 * Re-key the vault: verify the old passphrase, then re-encrypt every account's
 * seed under a key derived from a fresh salt + the new passphrase.
 *
 * Safety: all seeds are decrypted with the old key up front and the whole
 * operation aborts if any decryption fails — so a bad state can never be
 * half-written. Only after every seed decrypts do we re-encrypt + persist,
 * rewriting the `{salt, check}` verifier last and swapping the in-memory key.
 */
async function changePassphrase({ oldPassword, newPassword }) {
  if (!newPassword) throw new Error("New passphrase required");
  const config = await getVaultConfig();
  if (!config) throw new Error("Vault not configured");

  const oldKey = await Encrypter.scryptPass(oldPassword, config.salt);
  try {
    const decrypted = await Encrypter.decryptWithKey({
      encrypted: config.check,
      key: oldKey,
    });
    if (decrypted !== VAULT_CHECK_PLAINTEXT) throw new Error("mismatch");
  } catch {
    throw new Error("bad-passphrase");
  }

  // Decrypt every stored seed with the old key first — abort before any write.
  const ids = await listAccountIds();
  const pending = [];
  for (const id of ids) {
    const wallet = getWallet(id);
    const stored = await wallet.load();
    if (!stored?.encrypted) continue;
    let phrase;
    try {
      phrase = await wallet.decryptSeed(stored.encrypted, oldKey);
    } catch {
      throw new Error("Could not re-encrypt an existing wallet; passphrase unchanged");
    }
    pending.push({ id, stored, phrase });
  }

  const newSalt = Encrypter.generateSalt();
  const newKey = await Encrypter.scryptPass(newPassword, newSalt);

  for (const { id, stored, phrase } of pending) {
    const wallet = getWallet(id);
    const encrypted = await wallet.encryptSeed(phrase, newKey);
    await wallet.save({
      address: stored.address,
      rawAddress: stored.rawAddress,
      publicKey: stored.publicKey,
      // Preserved: dropping it would silently move a v3/v5 wallet back onto the
      // v4 contract on the next unlock.
      platform: platformOf(stored),
      encrypted,
    });
  }

  const check = await Encrypter.encryptWithKey({
    data: VAULT_CHECK_PLAINTEXT,
    key: newKey,
  });
  await storage.set(VAULT_STORAGE_KEY, { salt: newSalt, check });
  vaultKey = newKey;

  return { status: true, count: pending.length };
}

/* -------------------------------------------------------------------------- */
/* Backup / restore                                                            */
/* -------------------------------------------------------------------------- */

/** Every account id currently in the picker registry. */
async function listAccountIds() {
  const accounts = await storage.get(ACCOUNTS_STORAGE_KEY, []);
  if (!Array.isArray(accounts)) return [];
  return accounts
    .filter((a) => a && typeof a.id === "string" && a.id)
    .map((a) => a.id);
}

async function assertVaultPassword(password) {
  if (!password) throw new Error("Passphrase required");
  const config = await getVaultConfig();
  if (!config) throw new Error("Vault not configured");
  const key = await Encrypter.scryptPass(password, config.salt);
  let decrypted;
  try {
    decrypted = await Encrypter.decryptWithKey({
      encrypted: config.check,
      key,
    });
  } catch {
    throw new Error("bad-passphrase");
  }
  if (decrypted !== VAULT_CHECK_PLAINTEXT) throw new Error("bad-passphrase");
}

function parseBackup(json) {
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("Not a valid backup file");
  }
  if (!data || data.type !== "nilewallet-backup") {
    throw new Error("Not a NileWallet backup file");
  }
  if (data.version !== BACKUP_VERSION) {
    throw new Error(`Unsupported backup version: ${data.version}`);
  }
  if (typeof data.salt !== "string" || !data.salt) {
    throw new Error("Backup is missing its encryption salt");
  }
  if (!Array.isArray(data.entries) || data.entries.length === 0) {
    throw new Error("Backup contains no wallets");
  }

  data.entries.forEach((entry, index) => {
    const label = `Entry ${index + 1}`;
    if (!entry || typeof entry !== "object") throw new Error(`${label}: invalid`);
    if (typeof entry.account_id !== "string" || !entry.account_id) {
      throw new Error(`${label}: missing account_id`);
    }
    if (typeof entry.mnemonic_encrypted !== "string" || !entry.mnemonic_encrypted) {
      throw new Error(`${label}: missing encrypted mnemonic`);
    }
    if (typeof entry.address !== "string" || !entry.address) {
      throw new Error(`${label}: missing address`);
    }
    try {
      Address.parse(entry.address);
    } catch {
      throw new Error(`${label}: invalid address`);
    }
    if (entry.added_tokens !== undefined && !Array.isArray(entry.added_tokens)) {
      throw new Error(`${label}: invalid added_tokens`);
    }
    if (entry.platform !== undefined && !WALLET_PLATFORMS.includes(entry.platform)) {
      throw new Error(`${label}: unsupported wallet version ${entry.platform}`);
    }
  });

  return data;
}

async function decryptBackupEntry(entry, password, salt) {
  let phrase;
  try {
    phrase = await getWallet(entry.account_id).decryptFromBackup(
      entry.mnemonic_encrypted,
      password,
      salt,
    );
  } catch {
    throw new Error("Wrong passphrase or corrupted backup");
  }

  const derived = await getWallet(entry.account_id).importFromPhrase(
    phrase,
    entry.platform || DEFAULT_WALLET_PLATFORM,
  );
  const recorded = Address.parse(entry.address);
  if (!Address.parse(derived.address).equals(recorded)) {
    throw new Error("Backup entry address does not match its mnemonic");
  }
  return phrase;
}

/**
 * Export every stored wallet as an encrypted JSON backup.
 *
 * Two secrets are involved and they are deliberately distinct: the **vault
 * passphrase** proves the caller owns this vault, and the **backup password**
 * encrypts the export so the file can be restored on another machine. The UI
 * has always asked for both — previously it collected the backup password,
 * validated it, and then silently encrypted with the vault passphrase instead,
 * so a restore using the password the app had asked for failed with "Wrong
 * passphrase". The backup password is now what actually protects the file.
 */
async function handleWalletBackup(message) {
  const vKey = requireKey();
  await assertVaultPassword(message.password);

  const provided = String(message.backupPassword ?? "");
  if (provided && provided.length < MIN_BACKUP_PASSWORD_LENGTH) {
    throw new Error(
      `Backup password must be at least ${MIN_BACKUP_PASSWORD_LENGTH} characters`,
    );
  }
  const exportPassword = provided || String(message.password);

  const salt = Encrypter.generateSalt();
  const entries = [];

  for (const id of await listAccountIds()) {
    const wallet = getWallet(id);
    const stored = await wallet.load();
    if (!stored?.encrypted) continue;

    const phrase = await wallet.decryptSeed(stored.encrypted, vKey);
    const mnemonic_encrypted = await wallet.encryptForBackup(
      phrase,
      exportPassword,
      salt,
    );

    entries.push({
      account_id: id,
      farm_id: null,
      address: stored.address,
      platform: platformOf(stored),
      chain: BACKUP_CHAIN,
      mnemonic_encrypted,
      added_tokens: await wallet.listTokens(),
    });
  }

  if (entries.length === 0) throw new Error("No wallets to back up");

  const backup = {
    version: BACKUP_VERSION,
    type: "nilewallet-backup",
    created_at: Date.now(),
    salt,
    // Recorded so restore can tell the user which secret to type. Older files
    // predate this field and are treated as vault-passphrase exports.
    encrypted_with: provided ? "backup-password" : "vault-passphrase",
    entries,
  };

  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const filename = `nilewallet-backup-${date}.json`;

  return {
    status: true,
    filename,
    count: entries.length,
    json: JSON.stringify(backup, null, 2),
  };
}

async function handleRestorePreview(message) {
  const backup = parseBackup(message.json);
  const entries = [];

  for (const entry of backup.entries) {
    await decryptBackupEntry(entry, message.password, backup.salt);
    const existing = await getWallet(entry.account_id).load();
    entries.push({
      account_id: entry.account_id,
      address: entry.address,
      platform: entry.platform || DEFAULT_WALLET_PLATFORM,
      chain: entry.chain || BACKUP_CHAIN,
      token_count: Array.isArray(entry.added_tokens) ? entry.added_tokens.length : 0,
      exists: Boolean(existing?.encrypted),
    });
  }

  return {
    status: true,
    created_at: backup.created_at,
    encryptedWith: backup.encrypted_with || "vault-passphrase",
    entries,
  };
}

async function handleRestoreApply(message) {
  const vKey = requireKey();
  const backup = parseBackup(message.json);
  const overwrite = message.overwrite || {};

  let restored = 0;
  let skipped = 0;

  for (const entry of backup.entries) {
    const wallet = getWallet(entry.account_id);
    const existing = await wallet.load();

    if (existing?.encrypted && overwrite[entry.account_id] !== true) {
      skipped++;
      continue;
    }

    const phrase = await decryptBackupEntry(entry, message.password, backup.salt);
    const derived = await wallet.importFromPhrase(
      phrase,
      entry.platform || DEFAULT_WALLET_PLATFORM,
    );
    const encrypted = await wallet.encryptSeed(phrase, vKey);

    await wallet.save({
      address: derived.address,
      rawAddress: derived.rawAddress,
      publicKey: derived.publicKey,
      platform: derived.platform,
      encrypted,
    });
    await storage.set(
      `account-${entry.account_id}:nile-wallet:tokens`,
      Array.isArray(entry.added_tokens) ? entry.added_tokens : [],
    );

    // Ensure the restored account is present in the picker registry.
    const wallets = await listWallets();
    if (!wallets.some((w) => w.id === entry.account_id)) {
      wallets.push({
        id: entry.account_id,
        name: `Wallet ${wallets.length + 1}`,
        created: Date.now(),
      });
      await storage.set(ACCOUNTS_STORAGE_KEY, wallets);
    }

    restored++;
  }

  return { status: true, restored, skipped };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

const nileWallet = {
  vaultStatus: async () => {
    const config = await getVaultConfig();
    return { configured: Boolean(config), unlocked: Boolean(vaultKey) };
  },

  unlock: (password) => unlockVault(password),

  lock: () => {
    vaultKey = null;
    return { status: true };
  },

  changePassphrase: (message) => changePassphrase(message),

  /* ---- wallet registry (picker) ---- */
  listWallets: () => listWallets(),
  walletOverview: () => walletOverview(),
  createWallet: (name) => createWallet(name),
  renameWallet: (id, name) => renameWallet(id, name),
  deleteWallet: (id) => deleteWallet(id),

  get: async (accountId) => {
    const wallet = getWallet(accountId);
    const stored = await wallet.load();
    return {
      status: Boolean(stored),
      address: stored?.address || null,
      rawAddress: stored?.rawAddress || null,
      publicKey: stored?.publicKey || null,
      platform: stored?.platform || "v4r2",
    };
  },

  generate: async (accountId) => {
    const key = requireKey();
    const wallet = getWallet(accountId);
    const stored = await wallet.load();
    if (stored?.encrypted) throw new Error("Wallet already exists");

    const { phrase, address, rawAddress, publicKey, platform } = await wallet.generate();
    const encrypted = await wallet.encryptSeed(phrase, key);
    await wallet.save({ address, rawAddress, publicKey, platform, encrypted });
    return { status: true, address, rawAddress, publicKey, platform };
  },

  /**
   * Import a recovery phrase and place it on the wallet contract that actually
   * holds the funds.
   *
   * The same 24 words resolve to a different address under each wallet version,
   * and a seed created by another app is usually not the v4 shape this app
   * generates. Rather than guessing (and showing an empty wallet at an address
   * the user has never funded), every candidate address is asked about once and
   * the deployed/funded one wins.
   */
  importWallet: async (accountId, phrase) => {
    const key = requireKey();
    const wallet = getWallet(accountId);
    const stored = await wallet.load();
    if (stored?.encrypted) throw new Error("Wallet already exists");

    const probe = await wallet.importFromPhrase(phrase, DEFAULT_WALLET_PLATFORM);
    const detected = await wallet.detectPlatform(probe.publicKey);
    const result = await wallet.importFromPhrase(phrase, detected.platform);

    const encrypted = await wallet.encryptSeed(result.phrase, key);
    await wallet.save({
      address: result.address,
      rawAddress: result.rawAddress,
      publicKey: result.publicKey,
      platform: result.platform,
      encrypted,
    });
    return {
      status: true,
      address: result.address,
      rawAddress: result.rawAddress,
      publicKey: result.publicKey,
      platform: result.platform,
      detected: detected.platform,
      detectedBalanceNano: detected.balanceNano.toString(),
      detectedDeployed: detected.deployed,
    };
  },

  revealSeed: async (accountId) => {
    const key = requireKey();
    const wallet = getWallet(accountId);
    const stored = await wallet.load();
    if (!stored?.encrypted) throw new Error("No wallet for this account");
    const phrase = await wallet.decryptSeed(stored.encrypted, key);
    return { phrase };
  },

  clear: async (accountId) => {
    const wallet = getWallet(accountId);
    await wallet.clear();
    return { status: true };
  },

  balance: async (accountId) => {
    const wallet = getWallet(accountId);
    const stored = await wallet.load();
    if (!stored?.address) return { balance: null, error: "no-wallet" };
    try {
      const info = await wallet.getAccountInfo(stored.address);
      return {
        balance: fromNano(info.balanceNano),
        balanceNano: info.balanceNano.toString(),
        deployed: info.deployed,
        status: info.status,
      };
    } catch (error) {
      // A failed read is not a zero balance. Surfacing it as an error lets the
      // UI show "—" instead of claiming the wallet is empty.
      return { balance: null, error: error?.message || "unavailable" };
    }
  },

  listTokens: async (accountId) => {
    const wallet = getWallet(accountId);
    return { status: true, tokens: await wallet.listTokens() };
  },

  addToken: async (accountId, address) => {
    const wallet = getWallet(accountId);
    const token = await wallet.addToken(address);
    return { status: true, token };
  },

  removeToken: async (accountId, address) => {
    const wallet = getWallet(accountId);
    await wallet.removeToken(address);
    return { status: true };
  },

  /**
   * Every jetton balance for an account in one request, keyed by master
   * address. Used by the picker to assemble its portfolio without fanning out
   * one request per token.
   */
  jettonBalances: async (accountId) => {
    const wallet = getWallet(accountId);
    return { status: true, balances: await wallet.listJettonBalances() };
  },

  tokenBalance: async (accountId, token) => {
    const wallet = getWallet(accountId);
    // `null` means "could not be read" — the UI renders it as "—" rather than
    // as a zero holding.
    const balance = await wallet.getJettonBalance(token.jetton_master_address);
    return {
      status: true,
      jetton_master_address: token.jetton_master_address,
      balance,
    };
  },

  estimateTransfer: (accountId, params) =>
    handleTransferEstimate(accountId, params),

  sendTransfer: (accountId, params) => handleTransferSend(accountId, params),

  /** Subscribe to the outcome of a broadcast transfer (seqno confirmation). */
  onTransferSettled,

  backup: (message) => handleWalletBackup(message),

  restorePreview: (message) => handleRestorePreview(message),

  restoreApply: (message) => handleRestoreApply(message),
};

export default nileWallet;
