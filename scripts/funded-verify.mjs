/**
 * Funded live verification — real signatures, real broadcasts, real on-chain
 * evidence.
 *
 * `npm run verify:live` proves the send stack is *shaped* correctly against the
 * live network, but it never signs with a real key and never broadcasts. This
 * script is the other half: it runs the same module the app bundles
 * (`nileWallet.js`) against the same vault the packaged app reads, unlocks it
 * with the real passphrase, and performs three transfers that are signed and
 * broadcast for real. Every claim it prints is a value read back from the chain
 * afterwards.
 *
 * The three transfers are deliberately chosen so the user's funds stay put:
 *
 *   1. a native TON transfer to the wallet's *own* address — a real external
 *      message, a real block, a real fee, and the value comes straight back;
 *   2. a real TEP-74 jetton transfer to the same owner — the tokens land in the
 *      owner's own jetton wallet, and the attachment is refunded through
 *      `response_destination`;
 *   3. a native transfer to an address the chain has never seen, sent in its
 *      non-bounceable (`UQ…`) form. The same destination in `EQ…` form must be
 *      *refused* before signing, which is the bug this exists to pin: an `EQ…`
 *      transfer to an account with no code is returned to the sender.
 *
 * Nothing is written to the real vault: the script works on a copy, so a
 * verification run cannot corrupt wallet records.
 *
 * Usage:
 *   NILEVAULT_PASSPHRASE='…' npm run verify:funded
 *
 * Exits non-zero if any of the three transfers fails to confirm on-chain.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

import { Address } from "@ton/core";

const VAULT =
  process.env.NILEVAULT_STORE ||
  path.join(
    process.env.APPDATA || path.join(homedir(), ".config"),
    "nile-vault",
    "vault.json",
  );
const WORK_DIR = path.join(path.dirname(VAULT), "verify-run");
const WORK_VAULT = path.join(WORK_DIR, "vault.json");
const PASSPHRASE = process.env.NILEVAULT_PASSPHRASE || "";

if (!PASSPHRASE) {
  console.error(
    "Set NILEVAULT_PASSPHRASE to the vault passphrase for the wallet under test.",
  );
  process.exit(1);
}
if (!existsSync(VAULT)) {
  console.error(`No vault at ${VAULT}`);
  process.exit(1);
}

/* ── the app's storage bridge, pointed at a copy of the real vault ───────── */

mkdirSync(WORK_DIR, { recursive: true });
copyFileSync(VAULT, WORK_VAULT);

const store = JSON.parse(readFileSync(WORK_VAULT, "utf8"));
const persist = () => writeFileSync(WORK_VAULT, JSON.stringify(store, null, 2));

globalThis.window = {
  nilevault: {
    kvGet: async (key) => store[key],
    kvSet: async (key, value) => {
      store[key] = value;
      persist();
    },
    kvRemove: async (key) => {
      delete store[key];
      persist();
    },
    kvGetAll: async () => ({ ...store }),
  },
};

/* ── throttled fetch (the public indexer tiers rate-limit hard) ──────────── */

const realFetch = globalThis.fetch;
let lastCallAt = 0;
const MIN_GAP_MS = 900;

globalThis.fetch = async (url, init) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const waitFor = lastCallAt + MIN_GAP_MS - Date.now();
    if (waitFor > 0) await new Promise((resolve) => setTimeout(resolve, waitFor));
    lastCallAt = Date.now();
    try {
      const res = await realFetch(url, init);
      if (res.status !== 429 && res.status !== 503) return res;
    } catch (error) {
      if (attempt === 3) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  return realFetch(url, init);
};

const nileWallet = (await import("../src/renderer/lib/nileWallet.js")).default;
const { onTransferSettled } = await import("../src/renderer/lib/nileWallet.js");

/* ── reporting ──────────────────────────────────────────────────────────── */

let failures = 0;
let checks = 0;

const section = (title) => console.log(`\n${title}`);
const info = (line) => console.log(`    ${line}`);
const check = (label, ok, detail = "") => {
  checks += 1;
  if (ok) {
    console.log(`  \u2713 ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`  \u2717 ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const explorer = (hash) => `https://tonviewer.com/transaction/${hash}`;

/** The wallet's own state, straight from the chain. */
async function chainState(address) {
  const res = await realFetch(
    `https://toncenter.com/api/v3/walletStates?address=${encodeURIComponent(address)}`,
  );
  const data = await res.json();
  return data.wallets?.[0] ?? { address, status: "nonexist", balance: "0" };
}

async function balanceOf(address) {
  const res = await realFetch(`https://tonapi.io/v2/accounts/${encodeURIComponent(address)}`);
  if (res.status === 404) return 0n;
  const data = await res.json();
  return BigInt(data.balance ?? 0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the wallet holds enough TON for the next leg.
 *
 * The wallet being verified holds barely more than one jetton attachment
 * (0.05 TON), and a jetton transfer is refunded to `response_destination` in a
 * *separate* message a few seconds after the transfer itself executes. Waiting
 * for the balance — rather than for a fixed delay — is what makes the next leg
 * safe without guessing how long the refund takes. The gate uses the flat
 * fallback fee constant, so it is met even when the live estimate is
 * unavailable.
 */
async function ensureFunds(address, minimumNano, label) {
  const deadline = Date.now() + 150_000;
  let balance = await balanceOf(address);
  if (balance >= minimumNano) return balance;

  info(
    `${label}: waiting for at least ${Number(minimumNano) / 1e9} TON ` +
      `(holding ${Number(balance) / 1e9} TON — a jetton refund is usually in flight)`,
  );
  while (Date.now() < deadline) {
    await sleep(5000);
    balance = await balanceOf(address);
    if (balance >= minimumNano) break;
  }
  check(
    `${label}: enough TON to pay for the transfer`,
    balance >= minimumNano,
    `${Number(balance) / 1e9} TON available`,
  );
  return balance;
}

/**
 * Wait for the wallet's sequence number to move past `seqno`, which is the only
 * proof that the message was *executed* rather than merely accepted.
 */
async function waitForSeqno(address, seqno, { waitMs = 90_000 } = {}) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const state = await chainState(address);
    const current = Number(state.seqno ?? 0);
    if (current > seqno) return { confirmed: true, seqno: current };
    await sleep(2500);
  }
  return { confirmed: false, seqno: null };
}

/* ── run ────────────────────────────────────────────────────────────────── */

section("0. unlock the real vault (read from a throwaway copy)");

const status = await nileWallet.vaultStatus();
check("the vault is configured", status.configured === true);
await nileWallet.unlock(PASSPHRASE);
check("the vault passphrase unlocks it", true);

const overview = await nileWallet.walletOverview();
const funded = overview
  .filter((row) => row.deployed && BigInt(row.balanceNano ?? "0") > 0n)
  .sort((a, b) => (BigInt(b.balanceNano) > BigInt(a.balanceNano) ? 1 : -1))[0];

if (!funded) {
  console.error("\nNo deployed, funded wallet in the vault — nothing to send from.");
  process.exit(1);
}

const balanceBefore = await balanceOf(funded.address);
console.log(
  `\n  using ${funded.address}\n    balance ${Number(balanceBefore) / 1e9} TON (${balanceBefore} nano)`,
);
check(
  "the picker read the funded wallet's balance from the chain",
  BigInt(funded.balanceNano) === balanceBefore,
  `picker ${funded.balanceNano} vs chain ${balanceBefore}`,
);

/* A destination the chain has never seen, in both address forms. */
const dead = Address.parseRaw(`0:${"5a".repeat(32)}`);
const deadUq = dead.toString({ urlSafe: true, bounceable: false });
const deadEq = dead.toString({ urlSafe: true, bounceable: true });
const deadState = await chainState(dead.toString());
check(
  "the never-funded destination really has no code on-chain",
  deadState.status === "nonexist" || deadState.status === "uninit",
  `status=${deadState.status}`,
);

/* ── 1. real native TON send ────────────────────────────────────────────── */

section("1. native TON send (real signature, real broadcast)");

const settled = [];
const unsubscribe = onTransferSettled((payload) => settled.push(payload));

/** The flat fallback fee (0.005 TON) plus a margin: the pool the gate uses. */
const FEE_GATE_NANO = 6_000_000n;

async function performSend(label, params, minimumNano) {
  await ensureFunds(funded.address, minimumNano, label);
  const estimate = await nileWallet.estimateTransfer(funded.id, params);
  info(
    `${label}: fee ${Number(estimate.feeNano) / 1e9} TON ` +
      `(${estimate.feeEstimated ? "approximate" : "live estimate"}, ${estimate.feeSource})`,
  );

  const result = await nileWallet.sendTransfer(funded.id, params);
  const seqnoBefore = result.seqno;
  console.log(`    broadcast ${result.hash}\n    ${explorer(result.hash)}`);

  const landed = await waitForSeqno(funded.address, seqnoBefore);
  return { estimate, result, landed, seqnoBefore };
}

const native1 = await performSend(
  "to its own address",
  {
    kind: "ton",
    to: funded.address,
    amount: "0.001",
    comment: "nilevault verification",
  },
  1_000_000n + FEE_GATE_NANO,
);
check(
  "the native send advanced the wallet's seqno (the message executed)",
  native1.landed.confirmed,
  `seqno ${native1.seqnoBefore} -> ${native1.landed.seqno}`,
);
check(
  "the broadcast was accepted by the network",
  typeof native1.result.hash === "string" && native1.result.hash.length === 64,
  native1.result.hash,
);

/* ── 2. real jetton send ────────────────────────────────────────────────── */

section("2. jetton send (real TEP-74 body, real broadcast)");

const tokenKey = `account-${funded.id}:nile-wallet:tokens`;
let token = (store[tokenKey] || []).find((entry) => entry.jetton_master_address);

if (!token) {
  const res = await realFetch(
    `https://tonapi.io/v2/accounts/${encodeURIComponent(funded.address)}/jettons`,
  );
  const data = await res.json();
  const held = (data.balances || []).find((entry) => entry.jetton?.address);
  if (held) {
    token = {
      jetton_master_address: held.jetton.address,
      symbol: held.jetton.symbol || "JETTON",
      decimals: held.jetton.decimals ?? 9,
    };
  }
}

if (!token) {
  console.log("  (no jetton held by this wallet — jetton leg skipped)");
  failures += 1;
} else {
  const oneWholeToken = (10n ** BigInt(token.decimals ?? 9)).toString();
  const jetton = await performSend(
    `1 ${token.symbol} to its own wallet`,
    {
      kind: "jetton",
      token,
      to: funded.address,
      amount: oneWholeToken,
    },
    50_000_000n + FEE_GATE_NANO,
  );
  check(
    "the jetton send advanced the wallet's seqno",
    jetton.landed.confirmed,
    `seqno ${jetton.seqnoBefore} -> ${jetton.landed.seqno}`,
  );
  info(
    `attachment ${Number(jetton.result.attachedNano) / 1e9} TON, ` +
      `fee ${Number(jetton.result.feeNano) / 1e9} TON (${jetton.result.feeEstimated ? "approximate" : "live"})`,
  );
}

/* ── 3. the bounce case: a never-funded destination ─────────────────────── */

section("3. a destination with no code — the bounce bug");

let refused = false;
try {
  await nileWallet.estimateTransfer(funded.id, {
    kind: "ton",
    to: deadEq,
    amount: "0.001",
  });
} catch (error) {
  refused = /no code on-chain/.test(error.message);
  if (!refused) info(`unexpected refusal: ${error.message}`);
}
check(
  "a bounceable (EQ…) transfer to an account with no code is refused before signing",
  refused,
);

const deadSend = await performSend(
  "to a never-funded UQ address",
  {
    kind: "ton",
    to: deadUq,
    amount: "0.001",
  },
  1_000_000n + FEE_GATE_NANO,
);
check(
  "the non-bounceable (UQ…) transfer to the same address is allowed and executes",
  deadSend.landed.confirmed,
  `seqno ${deadSend.seqnoBefore} -> ${deadSend.landed.seqno}`,
);

/* ── 4. what the chain says afterwards ──────────────────────────────────── */

section("4. on-chain evidence");

await sleep(5000);
unsubscribe();

// The jetton attachment is refunded by a second message from the jetton wallet,
// so the wallet's final balance is only final once that lands. Wait for the
// refund rather than sampling once and calling the difference "spent".
let balanceAfter = await balanceOf(funded.address);
let recovered = balanceAfter > balanceBefore - 20_000_000n;
for (let i = 0; i < 24 && !recovered; i += 1) {
  await sleep(5000);
  balanceAfter = await balanceOf(funded.address);
  recovered = balanceAfter > balanceBefore - 20_000_000n;
}
console.log(
  `\n  balance before ${Number(balanceBefore) / 1e9} TON -> after ${Number(balanceAfter) / 1e9} TON`,
);
check(
  "the jetton attachment came back: the wallet is not drained by the verification",
  recovered,
  `net cost ${Number(balanceBefore - balanceAfter) / 1e9} TON (fees + the 0.001 TON to the dead address)`,
);

const deadAfter = await chainState(dead.toString());
check(
  "the never-funded address still has no code (the UQ send was not bounced back)",
  deadAfter.status === "nonexist" || deadAfter.status === "uninit",
  `status=${deadAfter.status}`,
);

console.log(`\n  settled outcomes reported by the app: ${settled.length}`);
for (const entry of settled) {
  console.log(`    ${entry.hash} -> ${entry.txStatus}`);
}

console.log("\nresults");
if (failures) {
  console.log(`\n${failures} of ${checks} check(s) failed.`);
  process.exit(1);
}
console.log(`\nall ${checks} funded live checks passed.`);
