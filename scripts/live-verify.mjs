/**
 * Live-network verification of the send stack.
 *
 * Runs the *real* transfer code — `readSeqno`, `resolveJettonWalletAddress`,
 * `buildTransferRequest`, TEP-74 body construction — against the live TON
 * network and against the real accounts in the local vault, reading only their
 * public metadata (address + public key).
 *
 * Nothing is signed with a real key and nothing is broadcast: messages are built
 * with a deterministic throwaway secret key purely so they have the correct
 * shape, exactly as the fee-estimate path does.
 *
 * This is the harness that would have caught both live bugs:
 *   - a bare `{ to, value, body }` message, which makes `storeMessageRelaxed`
 *     throw "Cannot read properties of undefined (reading 'type')";
 *   - `.storeMaybeCustomPayload(...)`, which is not a `@ton/core` Builder method.
 *
 * Deliberately NOT part of `npm test` — it needs the network.
 *
 * Usage: npm run verify:live
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

import { Address, Cell, loadMessage, loadMessageRelaxed, toNano } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import WalletInstance, {
  buildJettonTransferBody,
} from "../src/renderer/lib/WalletInstance.js";

const API_BASE = "https://tonapi.io/v2";
const VAULT =
  process.env.NILEVAULT_STORE ||
  path.join(process.env.APPDATA || path.join(homedir(), ".config"), "nile-vault", "vault.json");

/** A real, well-formed destination that is not any of the accounts under test. */
const RECIPIENT = "UQA6Oar6k6J7dsi-teP_IEvfCpEMpRiMuIRCeWnMVBHvpgBw";
const THROWAWAY_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/**
 * tonapi's public tier rate-limits hard, and this script deliberately makes
 * several calls per account. Throttle every request — including the ones the
 * library code under test makes — and retry on 429/503 so a rate limit can
 * never be mistaken for a code failure.
 */
const realFetch = globalThis.fetch;
let lastCallAt = 0;
const MIN_GAP_MS = 1200;

globalThis.fetch = async (url, init) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const waitFor = lastCallAt + MIN_GAP_MS - Date.now();
    if (waitFor > 0) await new Promise((r) => setTimeout(r, waitFor));
    lastCallAt = Date.now();

    let res;
    try {
      res = await realFetch(url, init);
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }

    if (res.status !== 429 && res.status !== 503) return res;
    if (attempt < 3) {
      process.stdout.write(
        `    (rate limited ${res.status}, retrying in ${1.5 * (attempt + 1)}s)\n`,
      );
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  lastCallAt = Date.now();
  return realFetch(url, init);
};

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    failures.push(name);
    console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const section = (title) => console.log(`\n${title}`);

/* ── read public metadata only (never the encrypted seed) ────────────────── */

const raw = JSON.parse(readFileSync(VAULT, "utf8"));
const accounts = [];
for (const [key, value] of Object.entries(raw)) {
  if (!/^account-.*:nile-wallet$/.test(key)) continue;
  if (!value?.address || !value?.publicKey) continue;
  const id = key.slice("account-".length, -":nile-wallet".length);
  accounts.push({
    id,
    address: value.address,
    publicKey: value.publicKey,
    tokens: (() => {
      const t = raw[`account-${id}:nile-wallet:tokens`];
      return Array.isArray(t) ? t : [];
    })(),
  });
}

if (accounts.length === 0) {
  console.error(`No accounts found in ${VAULT}`);
  process.exit(1);
}

console.log(`vault : ${VAULT}`);
console.log(`accounts: ${accounts.map((a) => a.address.slice(0, 14)).join(", ")}`);

const signer = await mnemonicToPrivateKey(THROWAWAY_MNEMONIC.split(" "));

/** One instance per account so its address-resolving storage stub is correct. */
function instanceFor(account) {
  return new WalletInstance({
    accountId: account.id,
    storage: {
      get: async (key, fallback) =>
        key.endsWith(":nile-wallet") ? { address: account.address } : fallback,
      set: async () => {},
      remove: async () => {},
    },
  });
}

function contractFor(account) {
  return WalletContractV4.create({
    workchain: 0,
    publicKey: Buffer.from(account.publicKey, "hex"),
  });
}

/* ── 1. raw tonapi responses for the real accounts ───────────────────────── */

section("1. raw tonapi responses for the real accounts");

for (const account of accounts) {
  const target = Address.parse(account.address).toString();

  const accountRes = await fetch(`${API_BASE}/accounts/${encodeURIComponent(target)}`);
  const accountBody = accountRes.status === 404 ? null : await accountRes.json();
  account.deployed = accountBody?.status === "active";
  account.balanceNano = BigInt(accountBody?.balance || 0);

  console.log(
    `\n  ${account.address}\n    /accounts/{addr} -> ${accountRes.status}` +
      (accountBody
        ? `  status=${accountBody.status} balance=${accountBody.balance} interfaces=${JSON.stringify(
            accountBody.interfaces || [],
          )}`
        : "  (never seen: genuinely undeployed)"),
  );

  const methodRes = await fetch(
    `${API_BASE}/blockchain/accounts/${encodeURIComponent(target)}/methods/getSeqno`,
  );
  const methodBody = methodRes.ok ? await methodRes.json() : null;
  console.log(`    /methods/getSeqno -> ${methodRes.status}`);
  console.log(`    raw: ${JSON.stringify(methodBody)}`);

  // The path the previous implementation used, with a bare 32-byte hash.
  const legacyHash = Address.parse(account.address).hash.toString("hex");
  const legacyRes = await fetch(
    `${API_BASE}/blockchains/accounts/${legacyHash}/methods/getSeqno`,
  );
  console.log(`    legacy /blockchains/accounts/<hash> -> ${legacyRes.status}`);

  // The old response shape the previous code read: `data.seqno`, which a
  // run-method response never contains.
  console.log(
    `    legacy parser would have returned: ${JSON.stringify(methodBody?.seqno ?? 0)} (always 0)`,
  );

  check(
    `${account.address.slice(0, 10)}… legacy plural path is not a real endpoint (${legacyRes.status})`,
    legacyRes.status === 404,
  );

  if (methodBody?.stack) {
    check(
      `${account.address.slice(0, 10)}… every stack entry has a defined .type`,
      methodBody.stack.every((e) => e && typeof e.type === "string"),
      `stack = ${JSON.stringify(methodBody.stack)}`,
    );
    check(
      `${account.address.slice(0, 10)}… stack is object-shaped, not the liteserver tuple shape`,
      methodBody.stack.every((e) => e && !Array.isArray(e)),
      `entries = ${methodBody.stack.map((e) => JSON.stringify(e)).join(", ")}`,
    );
  }
}

/* ── 2. the real seqno resolver, live ────────────────────────────────────── */

section("2. readSeqno (real code) against the live network");

for (const account of accounts) {
  try {
    const result = await instanceFor(account).readSeqno(account.address);
    console.log(
      `  ${account.address.slice(0, 14)}…  seqno=${result.seqno}  needsDeploy=${result.needsDeploy}  (deployed=${account.deployed})`,
    );
    check(
      `${account.address.slice(0, 10)}… readSeqno resolves without throwing`,
      Number.isInteger(result.seqno) && result.seqno >= 0,
    );
    if (account.deployed) {
      check(
        `${account.address.slice(0, 10)}… deployed wallet resolved a non-zero seqno`,
        result.seqno > 0,
        `seqno came back ${result.seqno} for an active wallet — a real send would be signed against a stale seqno`,
      );
    }
    account.seqno = result.seqno;
  } catch (error) {
    check(
      `${account.address.slice(0, 10)}… readSeqno resolves without throwing`,
      false,
      `${error.name}: ${error.message}`,
    );
  }
}

/* ── 3. native transfer: real build + real sign + BOC re-parse ───────────── */

section("3. native TON transfer (real build/sign path, never broadcast)");

for (const account of accounts) {
  const contract = contractFor(account);

  check(
    `${account.address.slice(0, 10)}… stored address derives from the stored public key`,
    contract.address.toString() === Address.parse(account.address).toString(),
    `derived ${contract.address.toString()} vs stored ${account.address}`,
  );

  try {
    const { boc, seqno, needsDeploy } = await instanceFor(account).buildTransferRequest({
      contract,
      keyPair: signer,
      to: RECIPIENT,
      amountRaw: toNano("0.01"),
    });

    console.log(
      `  ${account.address.slice(0, 14)}…  seqno=${seqno} needsDeploy=${needsDeploy} boc=${boc.length} chars`,
    );

    check(
      `${account.address.slice(0, 10)}… native transfer builds without "reading 'type'"`,
      true,
    );

    // Decode the outer message with this module's own copy so the check is
    // self-consistent: tag `10` is external-in, then the destination address.
    // Byte-level structure of the signed cell is asserted in the offline suite
    // (tests/send.test.mjs), which parses BOCs with the same module instance.
    // Here we only need evidence that the live build path produced a real,
    // fully-serialized external message rather than bailing out early.
    const root = Cell.fromBase64(boc);
    check(
      `${account.address.slice(0, 10)}… signed cell is a real BOC root (${root.bits.length} bits)`,
      root.bits.length > 500,
    );
    check(
      `${account.address.slice(0, 10)}… first send attaches stateInit so the wallet deploys`,
      needsDeploy ? root.refs.length > 0 : true,
      `needsDeploy=${needsDeploy} refs=${root.refs.length}`,
    );
  } catch (error) {
    check(
      `${account.address.slice(0, 10)}… native transfer builds without "reading 'type'"`,
      false,
      `${error.name}: ${error.message}`,
    );
  }
}

/* ── 4. jetton transfer: real resolution + real body + BOC re-parse ──────── */

section("4. Jetton transfer (real TEP-74 path, never broadcast)");

for (const account of accounts) {
  for (const token of account.tokens) {
    const instance = instanceFor(account);
    let jettonWallet = null;

    try {
      jettonWallet = await instance.resolveJettonWalletAddress(token.jetton_master_address);
      console.log(
        `\n  ${token.symbol || "token"} (${String(token.jetton_master_address).slice(0, 14)}…)\n    owner ${account.address.slice(0, 14)}… -> jetton wallet ${jettonWallet}`,
      );
      let friendly = false;
      try {
        friendly = Boolean(Address.parse(jettonWallet));
      } catch {
        friendly = false;
      }
      check(`jetton wallet resolves for ${token.symbol || "token"}`, friendly, `got ${jettonWallet}`);
    } catch (error) {
      check(
        `jetton wallet resolves for ${token.symbol || "token"}`,
        false,
        `${error.name}: ${error.message}`,
      );
    }

    if (!jettonWallet) continue;

    try {
      const { boc } = await instance.buildTransferRequest({
        contract: contractFor(account),
        keyPair: signer,
        to: RECIPIENT,
        amountRaw: 1_000_000_000n,
        jetton: {
          jetton_master_address: token.jetton_master_address,
          jetton_wallet_address: jettonWallet,
          symbol: token.symbol || "JETTON",
          decimals: token.decimals ?? 9,
        },
      });

      // The BOC's *size* is not a signal: a deployed wallet carries no
      // `state_init`, so its external message is legitimately short (a wallet
      // that still needs deploying is the long one). What has to hold is that
      // the signed cell exists, parses, and addresses the owner's jetton wallet
      // — a body that mentions a contract the chain does not know would be a
      // repeat of the bug this session exists to fix.
      let root = null;
      try {
        root = Cell.fromBase64(boc).beginParse();
      } catch {
        root = null;
      }
      const signedMessage = root ? loadMessage(root) : null;
      const target = signedMessage?.body
        ? loadMessageRelaxed(signedMessage.body.beginParse().skip(512 + 32 + 32 + 32 + 8 + 8).loadRef().beginParse())
            .info?.dest
        : null;

      check(
        `jetton transfer builds — no "storeMaybeCustomPayload is not a function"`,
        typeof boc === "string" && root !== null,
        `boc ${boc?.length ?? 0} chars, parses as ${root ? "a BOC root" : "nothing"}`,
      );
      check(
        "the signed jetton message is addressed to the owner's jetton wallet",
        Boolean(target) && Address.parse(jettonWallet).equals(target),
        `got ${target?.toString() ?? "none"}, expected ${jettonWallet}`,
      );
      console.log(`    built ${boc.length} base64 chars, dest=${target?.toString()}`);
    } catch (error) {
      check(
        `jetton transfer builds — no "storeMaybeCustomPayload is not a function"`,
        false,
        `${error.name}: ${error.message}`,
      );
    }

    // The body itself, independent of the wallet wrapper.
    try {
      const body = buildJettonTransferBody({
        amountRaw: 1_000_000_000n,
        destination: RECIPIENT,
        responseDestination: account.address,
      });
      // Walk the body field by field. Every field must be consumed, leaving
      // exactly zero bits — that is what proves the layout matches TEP-74
      // rather than merely being parseable.
      const slice = body.beginParse();
      const op = slice.loadUint(32);
      const queryId = slice.loadUintBig(64);
      const amount = slice.loadCoins();
      const destination = slice.loadAddress();
      const responseDestination = slice.loadAddress();
      const customPayloadPresent = slice.loadBit();
      const forwardTon = slice.loadCoins();
      const forwardPayloadInline = slice.loadBit();

      console.log(
        `    body: op=0x${op.toString(16)} queryId=${queryId} amount=${amount}\n` +
          `          dest=${destination?.toString()}\n` +
          `          responseDest=${responseDestination?.toString()}\n` +
          `          customPayload=${customPayloadPresent} forwardTon=${forwardTon} forwardInline=${forwardPayloadInline} leftoverBits=${slice.remainingBits}`,
      );
      check("TEP-74 opcode is 0x0f8a7ea5", op === 0x0f8a7ea5, `got 0x${op.toString(16)}`);
      check("TEP-74 amount round-trips", amount === 1_000_000_000n);
      // Compare by address identity, not by string form: EQ… and UQ… are the
      // same account and the library normalises to the bounceable form.
      check(
        "TEP-74 destination is the intended recipient",
        Boolean(destination) && Address.parse(RECIPIENT).equals(destination),
        `got ${destination?.toString()}`,
      );
      check(
        "TEP-74 response_destination is the sender (leftover TON comes home)",
        Boolean(responseDestination) &&
          Address.parse(account.address).equals(responseDestination),
        `got ${responseDestination?.toString()}`,
      );
      check("TEP-74 custom_payload is absent (flag 0)", customPayloadPresent === false);
      check("TEP-74 forward_ton_amount is 1n", forwardTon === 1n, `got ${forwardTon}`);
      check(
        "TEP-74 body consumes exactly every bit (layout is exact)",
        slice.remainingBits === 0,
        `${slice.remainingBits} bits left over`,
      );
    } catch (error) {
      check(
        "TEP-74 body builds with the installed @ton/core Builder",
        false,
        `${error.name}: ${error.message}`,
      );
    }
  }
}

if (accounts.every((a) => a.tokens.length === 0)) {
  console.log("  (no tracked tokens in the vault)");
}

/* ── summary ─────────────────────────────────────────────────────────────── */

console.log("\nresults");
if (failures.length) {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAILED: ${f}`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed`);
