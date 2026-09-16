/**
 * Send-stack tests.
 *
 * These pin down the parts of the transfer path that are easy to break and hard
 * to notice: the amount conversions, address acceptance, the exact TEP-74 body
 * layout, which address a jetton transfer is actually sent to, whether the
 * broadcast payload is a complete external-in message, and how the wallet's
 * sequence number is resolved.
 *
 * Run with `npm test` (esbuild bundles the ESM sources so Node can execute them;
 * the app's package.json is intentionally not `type: module` because the
 * Electron main process is CommonJS).
 */

import assert from "node:assert/strict";

import {
  Address,
  beginCell,
  Cell,
  external,
  internal,
  loadMessage,
  loadMessageRelaxed,
  storeMessage,
  toNano,
} from "@ton/core";
import { mnemonicNew, mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import {
  TON_DECIMALS,
  compareAmounts,
  decToRaw,
  formatAmount,
  groupDigits,
  rawToDec,
} from "../src/renderer/lib/amount.js";
import {
  isValidAddress,
  parseTransferInput,
  sameAddress,
  toDisplayAddress,
  truncateAddress,
} from "../src/renderer/lib/address.js";
import WalletInstance, {
  FEE_FALLBACK_NANO,
  JETTON_ATTACHED_TON,
  JETTON_FORWARD_TON,
  JETTON_TRANSFER_OP,
  SWEEP_SEND_MODE,
  buildJettonTransferBody,
  fetchWalletStates,
} from "../src/renderer/lib/WalletInstance.js";
import nileWallet from "../src/renderer/lib/nileWallet.js";
import { resetTransferQueue } from "../src/renderer/lib/sendQueue.js";
import {
  DEFAULT_WALLET_PLATFORM,
  WALLET_PLATFORMS,
  buildWalletContract,
  commentToCell,
  externalInHashNormalized,
  generateQueryId,
  isExpiredTransferError,
  isSeqnoMismatchError,
  normalizeWalletPlatform,
  signingPlatformConflict,
  withFeeHeadroom,
} from "../src/renderer/lib/tonStandards.js";

/* ── tiny harness ─────────────────────────────────────────────────────────── */

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  \u2717 ${name}\n      ${error.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/** A well-known, valid bounceable mainnet address. */
const EQ_ADDR = "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N";
/** The same account expressed as non-bounceable (checksum differs with the tag). */
const UQ_ADDR = Address.parse(EQ_ADDR).toString({ urlSafe: true, bounceable: false });
/** Arbitrary distinct addresses for sender/recipient/jetton-wallet roles. */
const JETTON_WALLET = Address.parseRaw(`0:${"22".repeat(32)}`);
const JETTON_MASTER = Address.parseRaw(`0:${"33".repeat(32)}`);

/** Storage adapter shim matching the { get, set, remove } contract. */
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: async (key, fallback = null) => (map.has(key) ? map.get(key) : fallback),
    set: async (key, value) => {
      map.set(key, value);
    },
    remove: async (key) => {
      map.delete(key);
    },
  };
}

/**
 * Install a fetch stub and record every URL it is asked for.
 *
 * `routes` maps a URL substring to a handler returning { status, body }.
 */
function stubFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const record = {
      url: String(url),
      method: options.method || "GET",
      body: options.body || null,
    };
    calls.push(record);
    for (const [needle, handler] of routes) {
      if (String(url).includes(needle)) {
        const result = await handler(String(url), options);
        return {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          json: async () => result.body,
          text: async () => JSON.stringify(result.body),
        };
      }
    }
    throw new Error(`unstubbed fetch: ${url}`);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function makeWallet(accountId = "test-account") {
  const words = await mnemonicNew(24);
  const keyPair = await mnemonicToPrivateKey(words);
  const contract = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  const storage = makeStorage({
    [`account-${accountId}:nile-wallet`]: {
      address: contract.address.toString({ urlSafe: true, bounceable: false }),
      rawAddress: contract.address.toRawString(),
      publicKey: keyPair.publicKey.toString("hex"),
    },
  });
  return {
    wallet: new WalletInstance({ storage, accountId }),
    keyPair,
    contract,
    storage,
  };
}

/**
 * Unwrap a signed transfer BOC back into its inner message, following the
 * WalletV4 signing layout: signature, wallet id, valid-until, seqno, then the
 * action list (type byte, then per message a send-mode byte and a message ref).
 */
function decodeTransfer(boc) {
  const message = loadMessage(Cell.fromBase64(boc).beginParse());
  const slice = message.body.beginParse();
  slice.skip(512); // ed25519 signature
  slice.loadUint(32); // wallet id
  const validUntil = slice.loadUint(32);
  const seqno = slice.loadUint(32);
  const actionType = slice.loadUint(8);
  const sendMode = slice.loadUint(8);
  const inner = loadMessageRelaxed(slice.loadRef().beginParse());
  return { message, seqno, validUntil, actionType, sendMode, inner };
}

/**
 * A `/walletStates` route over a table of `address → state`.
 *
 * The endpoint takes a comma-separated batch and answers per address, so the
 * fake has to answer for whichever addresses the code under test asks about —
 * that is the whole point of the batched read.
 */
function walletStatesRoute(table) {
  return [
    "/walletStates",
    (url) => {
      const query = decodeURIComponent(String(url).split("address=")[1] || "");
      const wallets = [];
      for (const asked of query.split(",")) {
        const address = asked.trim();
        if (!address) continue;
        const match = Object.entries(table).find(([known]) => sameAddress(known, address));
        if (!match) continue;
        const [, state] = match;
        wallets.push({
          address: Address.parse(address).toRawString(),
          balance: String(state.balance ?? 0),
          status: state.status || "active",
          seqno: state.seqno ?? 0,
          is_wallet: state.isWallet !== false,
          wallet_type: state.walletType || "wallet v4 r2",
        });
      }
      return { status: 200, body: { wallets, address_book: {} } };
    },
  ];
}

/** A `{ ok: true, result: { source_fees, destination_fees } }` fee response. */
function feeRoute(sourceFees, destinationFees = []) {
  return [
    "/estimateFee",
    (url, options) => ({
      status: 200,
      body: {
        ok: true,
        request: options?.body ? JSON.parse(options.body) : null,
        result: { source_fees: sourceFees, destination_fees: destinationFees },
      },
    }),
  ];
}

/**
 * Install an in-memory `window.nilevault` bridge so the vault / wallet layers
 * (which read storage through it) can run under Node.
 */
function installBridge() {
  const map = new Map();
  globalThis.window = {
    nilevault: {
      kvGet: async (key) => (map.has(key) ? map.get(key) : undefined),
      kvSet: async (key, value) => {
        map.set(key, value);
      },
      kvRemove: async (key) => {
        map.delete(key);
      },
      kvGetAll: async () => Object.fromEntries(map),
    },
  };
  return map;
}

/* ── tests ────────────────────────────────────────────────────────────────── */

async function run() {
  section("amount: decimal \u2194 base units");

  await test("converts a decimal string to base units exactly", () => {
    assert.equal(decToRaw("1.5", TON_DECIMALS), 1500000000n);
    assert.equal(decToRaw("0.000000001", TON_DECIMALS), 1n);
    assert.equal(decToRaw("1000", TON_DECIMALS), 1000000000000n);
  });

  await test("tolerates grouping and whitespace users paste in", () => {
    assert.equal(decToRaw(" 1,500.25 ", TON_DECIMALS), 1500250000000n);
    assert.equal(decToRaw("1_000", TON_DECIMALS), 1000000000000n);
  });

  await test("rejects malformed amounts with a readable message", () => {
    assert.throws(() => decToRaw("", TON_DECIMALS), /valid amount/);
    assert.throws(() => decToRaw("abc", TON_DECIMALS), /valid amount/);
    assert.throws(() => decToRaw("-1", TON_DECIMALS), /valid amount/);
    assert.throws(() => decToRaw("1.2.3", TON_DECIMALS), /valid amount/);
  });

  await test("rejects more fraction digits than the asset supports", () => {
    assert.throws(() => decToRaw("1.1234567891", TON_DECIMALS), /Too many decimals/);
    assert.equal(decToRaw("1.123456", 6), 1123456n);
    assert.throws(() => decToRaw("1.1234567", 6), /Too many decimals/);
  });

  await test("round-trips without precision loss", () => {
    const samples = ["1", "0.1", "123456.789012345", "0.000000001"];
    for (const sample of samples) {
      assert.equal(rawToDec(decToRaw(sample, TON_DECIMALS), TON_DECIMALS), sample);
    }
  });

  await test("keeps precision beyond Number.MAX_SAFE_INTEGER", () => {
    const huge = "9007199254740993.123456789";
    const raw = decToRaw(huge, TON_DECIMALS);
    assert.equal(rawToDec(raw, TON_DECIMALS), huge);
  });

  section("amount: display formatting");

  await test("groups thousands and trims trailing zeroes", () => {
    assert.equal(formatAmount(1234567890000000n), "1,234,567.89");
    assert.equal(formatAmount(1500000000n), "1.5");
    assert.equal(formatAmount(1000000000n), "1");
    assert.equal(groupDigits("1234567"), "1,234,567");
  });

  await test("never collapses a non-zero balance to zero", () => {
    // 1 nano is well below the 4-decimal display window; rather than rounding it
    // away to "0" the window widens to the first significant digit.
    assert.equal(formatAmount(1n, { maxFraction: 4 }), "0.000000001");
    assert.notEqual(formatAmount(1n, { maxFraction: 4 }), "0");
    assert.equal(formatAmount(0n, { maxFraction: 4 }), "0");
    // Within the window the bounded form is used; nothing significant is hidden.
    assert.equal(formatAmount(1500000001n, { maxFraction: 4 }), "1.5");
    assert.equal(formatAmount(1500000001n, { maxFraction: null }), "1.500000001");
  });

  await test("can render the exact value when the caller asks for it", () => {
    assert.equal(formatAmount(1n, { maxFraction: null }), "0.000000001");
    assert.equal(formatAmount(0n, { maxFraction: null }), "0");
    assert.equal(formatAmount(1234567890n, { maxFraction: null }), "1.23456789");
  });

  await test("compares amounts numerically, not lexically", () => {
    assert.equal(compareAmounts("10", "9"), 1);
    assert.equal(compareAmounts("9", "10"), -1);
    assert.equal(compareAmounts("1.0", "1"), 0);
    assert.equal(compareAmounts("nonsense", "1"), null);
  });

  section("address: EQ / UQ / raw acceptance");

  await test("accepts bounceable, non-bounceable and raw forms", () => {
    assert.equal(isValidAddress(EQ_ADDR), true);
    assert.equal(isValidAddress(UQ_ADDR), true);
    assert.equal(isValidAddress(`0:${"11".repeat(32)}`), true);
  });

  await test("rejects a corrupted checksum and junk", () => {
    const tampered = `${EQ_ADDR.slice(0, -1)}${EQ_ADDR.endsWith("N") ? "M" : "N"}`;
    assert.equal(isValidAddress(tampered), false);
    assert.equal(isValidAddress("not-an-address"), false);
    assert.equal(isValidAddress(""), false);
  });

  await test("normalizes every accepted form to the same UQ address", () => {
    const display = toDisplayAddress(EQ_ADDR);
    assert.ok(display.startsWith("UQ"), `expected UQ…, got ${display}`);
    assert.equal(sameAddress(EQ_ADDR, UQ_ADDR), true);
    assert.equal(sameAddress(EQ_ADDR, UQ_ADDR.slice(0, -1) + "X"), false);
  });

  await test("truncates for display", () => {
    assert.equal(truncateAddress(EQ_ADDR), "EQCD39…8xqB2N");
    assert.equal(truncateAddress(""), "");
  });

  section("address: pasted transfer links");

  await test("extracts recipient and amount from a ton:// transfer link", () => {
    const parsed = parseTransferInput(
      `ton://transfer/${EQ_ADDR}?amount=1500000000`,
    );
    assert.equal(sameAddress(parsed.address, EQ_ADDR), true);
    assert.equal(parsed.amount, "1.5");
  });

  await test("handles a link without an amount and a bare address", () => {
    assert.deepEqual(parseTransferInput(EQ_ADDR), {
      address: toDisplayAddress(EQ_ADDR),
      amount: "",
    });
    const noAmount = parseTransferInput(`ton://transfer/${EQ_ADDR}`);
    assert.equal(noAmount.amount, "");
    assert.equal(sameAddress(noAmount.address, EQ_ADDR), true);
  });

  await test("passes unrecognized input through for validation to reject", () => {
    assert.deepEqual(parseTransferInput("hello"), { address: "hello", amount: "" });
  });

  section("jetton: TEP-74 body layout");

  await test("pins the @ton/core Builder API this code depends on", () => {
    // `storeMaybeCustomPayload` looks plausible and does not exist. Calling it
    // throws only at runtime, in the packaged app, on a real send — so assert
    // the contract explicitly instead of trusting the name to be real.
    const builder = beginCell();
    assert.equal(
      typeof builder.storeMaybeCustomPayload,
      "undefined",
      "storeMaybeCustomPayload is not part of @ton/core's Builder",
    );
    for (const method of ["storeBit", "storeCoins", "storeAddress", "storeMaybeRef"]) {
      assert.equal(typeof builder[method], "function", `Builder.${method} must exist`);
    }
  });

  await test("encodes the standard transfer op and field order", () => {
    const destination = Address.parseRaw(`0:${"44".repeat(32)}`);
    const response = Address.parseRaw(`0:${"55".repeat(32)}`);
    const body = buildJettonTransferBody({
      amountRaw: 123456789n,
      destination,
      responseDestination: response,
    });

    const slice = body.beginParse();
    assert.equal(slice.loadUint(32), 0x0f8a7ea5, "op must be TEP-74 transfer");
    assert.equal(slice.loadUintBig(64), 0n, "query_id");
    assert.equal(slice.loadCoins(), 123456789n);
    assert.equal(slice.loadAddress().toString(), destination.toString());
    assert.equal(slice.loadAddress().toString(), response.toString());
    assert.equal(slice.loadBit(), false, "no custom payload");
    assert.equal(slice.loadCoins(), JETTON_FORWARD_TON);
    assert.equal(slice.loadBit(), false, "no forward payload");
    assert.equal(slice.remainingBits, 0, "body fully consumed");
    assert.equal(slice.remainingRefs, 0);
  });

  await test("never emits the non-standard outer opcode the old code wrapped it in", () => {
    const body = buildJettonTransferBody({
      amountRaw: 1n,
      destination: Address.parseRaw(`0:${"44".repeat(32)}`),
      responseDestination: null,
    });
    assert.notEqual(body.beginParse().loadUint(32), 0x362c90ee);
  });

  section("transfer: broadcast payload is a complete message");

  await test("wraps the signed body in an external-in message for the wallet", async () => {
    const { wallet, keyPair, contract } = await makeWallet();
    const stub = stubFetch([
      ["/methods/getSeqno", () => ({ status: 200, body: { success: true, exit_code: 0, stack: [{ type: "num", num: "0x2a" }] } })],
      ["/v2/accounts/", () => ({ status: 200, body: { status: "active", balance: "5000000000", interfaces: ["wallet_v4r2"] } })],
    ]);
    try {
      const destination = Address.parseRaw(`0:${"66".repeat(32)}`);
      const result = await wallet.buildTransferRequest({
        contract,
        keyPair,
        to: destination.toString(),
        amountRaw: toNano("1.5"),
      });

      const message = loadMessage(Cell.fromBase64(result.boc).beginParse());
      assert.equal(message.info.type, "external-in");
      assert.equal(
        message.info.dest.toString(),
        contract.address.toString(),
        "external message must target the wallet itself",
      );
      assert.equal(result.seqno, 42, "seqno read from the chain, not defaulted to 0");
      assert.equal(result.needsDeploy, false);
    } finally {
      stub.restore();
    }
  });

  await test("native transfer goes to the recipient with the exact value", async () => {
    const { wallet, keyPair, contract } = await makeWallet();
    const stub = stubFetch([
      ["/methods/getSeqno", () => ({ status: 200, body: { success: true, exit_code: 0, stack: [{ type: "num", num: "0x0" }] } })],
      ["/v2/accounts/", () => ({ status: 200, body: { status: "active", balance: "5000000000", interfaces: ["wallet_v4r2"] } })],
    ]);
    try {
      const destination = Address.parseRaw(`0:${"66".repeat(32)}`);
      const result = await wallet.buildTransferRequest({
        contract,
        keyPair,
        to: destination.toString(),
        amountRaw: toNano("1.5"),
      });
      const { actionType, sendMode, inner } = decodeTransfer(result.boc);
      assert.equal(actionType, 0, "action 0 is sendMsg");
      assert.equal(sendMode, 3);
      assert.equal(inner.info.type, "internal");
      assert.equal(inner.info.dest.toString(), destination.toString());
      assert.equal(inner.info.value.coins, toNano("1.5"));
      assert.equal(inner.body.bits.length, 0, "simple transfer carries no body");
    } finally {
      stub.restore();
    }
  });

  await test("jetton transfer is addressed to the sender's jetton wallet, not the recipient", async () => {
    const { wallet, keyPair, contract } = await makeWallet();
    const stub = stubFetch([
      ["/methods/getSeqno", () => ({ status: 200, body: { success: true, exit_code: 0, stack: [{ type: "num", num: "0x7" }] } })],
      ["/v2/accounts/", () => ({ status: 200, body: { status: "active", balance: "5000000000", interfaces: ["wallet_v4r2"] } })],
    ]);
    try {
      const destination = Address.parseRaw(`0:${"66".repeat(32)}`);
      const result = await wallet.buildTransferRequest({
        contract,
        keyPair,
        to: destination.toString(),
        amountRaw: 1_000_000n,
        jetton: {
          jetton_master_address: JETTON_MASTER.toString(),
          jetton_wallet_address: JETTON_WALLET.toString(),
          symbol: "USDT",
          decimals: 6,
        },
      });

      const { inner } = decodeTransfer(result.boc);
      assert.equal(
        inner.info.dest.toString(),
        JETTON_WALLET.toString(),
        "must target the owner's jetton wallet",
      );
      assert.notEqual(inner.info.dest.toString(), destination.toString());
      assert.equal(
        inner.info.value.coins,
        JETTON_ATTACHED_TON,
        "the message must fund the jetton wallet's gas (TEP-74 attachment)",
      );

      const body = inner.body.beginParse();
      assert.equal(body.loadUint(32), JETTON_TRANSFER_OP);
      // Consumed to keep the walk aligned, not asserted here: the query id is
      // random per transfer by design (TEP-74) and is covered by its own test.
      body.loadUintBig(64);
      assert.equal(body.loadCoins(), 1_000_000n);
      assert.equal(body.loadAddress().toString(), destination.toString());
      assert.equal(
        body.loadAddress().toString(),
        contract.address.toString(),
        "response destination must be the sender so excess TON returns",
      );
      // Walk the tail too. Without this the body can be *parseable* while still
      // being the wrong layout — which is exactly how a non-existent Builder
      // method (`storeMaybeCustomPayload`) once slipped through.
      assert.equal(body.loadBit(), false, "custom_payload must be absent (flag 0)");
      assert.equal(
        body.loadCoins(),
        JETTON_FORWARD_TON,
        "forward_ton_amount must credit the recipient's own jetton wallet",
      );
      assert.equal(body.loadBit(), false, "forward_payload must be absent");
      assert.equal(
        body.remainingBits,
        0,
        "the body must be exactly the TEP-74 layout with no bits left over",
      );
      assert.equal(body.remainingRefs, 0, "no unreferenced cells left in the body");
    } finally {
      stub.restore();
    }
  });

  await test("attaches stateInit so the first transfer deploys the wallet", async () => {
    const { wallet, keyPair, contract } = await makeWallet();
    const stub = stubFetch([
      // Undeployed accounts are not callable, so the run-method 404s.
      ["/methods/getSeqno", () => ({ status: 404, body: { error: "entity not found" } })],
      ["/v2/accounts/", () => ({ status: 200, body: { status: "uninit", balance: "173086149835", interfaces: [] } })],
    ]);
    try {
      const result = await wallet.buildTransferRequest({
        contract,
        keyPair,
        to: Address.parseRaw(`0:${"66".repeat(32)}`).toString(),
        amountRaw: toNano("1"),
      });
      assert.equal(result.needsDeploy, true);
      assert.equal(result.seqno, 0, "an undeployed wallet genuinely has seqno 0");

      const message = loadMessage(Cell.fromBase64(result.boc).beginParse());
      assert.ok(message.init, "stateInit must be attached so the wallet deploys");
    } finally {
      stub.restore();
    }
  });

  section("broadcast: targets the live tonapi endpoint");

  await test("posts to /blockchain/message, not the removed /sendBoc path", async () => {
    const { wallet } = await makeWallet();
    const stub = stubFetch([
      [
        "/blockchain/message",
        () => ({ status: 200, body: { message_hash: "deadbeef" } }),
      ],
    ]);
    try {
      const result = await wallet.broadcastTransfer(
        beginCell().endCell().toBoc().toString("base64"),
      );
      assert.equal(result.hash, "deadbeef", "should return the message hash from tonapi");
      const call = stub.calls.find((c) =>
        c.url.endsWith("/blockchain/message") || c.url.includes("/blockchain/message?"),
      );
      assert.ok(call, "should hit /blockchain/message");
      const sentBoc = JSON.parse(call.body || "{}").boc;
      assert.ok(sentBoc, "request must carry the boc");
      assert.ok(
        !stub.calls.some((c) => c.url.includes("/sendBoc")),
        "the old /sendBoc endpoint was removed from tonapi — never call it",
      );
    } finally {
      stub.restore();
    }
  });

  section("seqno resolution");

  await test("uses the documented run-method path", async () => {
    const { wallet, contract } = await makeWallet();
    const stub = stubFetch([
      ["/methods/getSeqno", () => ({ status: 200, body: { success: true, exit_code: 0, stack: [{ type: "num", num: "0x1" }] } })],
      ["/v2/accounts/", () => ({ status: 200, body: { status: "active", balance: "1", interfaces: ["wallet_v4r2"] } })],
    ]);
    try {
      await wallet.readSeqno(contract.address.toString());
      const call = stub.calls.find((c) => c.url.includes("getSeqno"));
      assert.ok(call, "should call getSeqno");
      assert.ok(
        call.url.includes("/blockchain/accounts/"),
        `expected the singular /blockchain/ path, got ${call.url}`,
      );
      assert.ok(!call.url.includes("/blockchains/"), "the old plural path does not exist");
      assert.ok(
        !call.url.includes(contract.address.hash.toString("hex")),
        "must pass a full address, not a bare hash",
      );
    } finally {
      stub.restore();
    }
  });

  await test("reads the seqno out of tonapi's object-shaped stack", async () => {
    const { wallet, contract } = await makeWallet();
    const stub = stubFetch([
      // Verbatim shape observed from tonapi for a real v4r2 wallet.
      ["/methods/getSeqno", () => ({ status: 200, body: { success: false, exit_code: 11, stack: [{ type: "num", num: "0x18703" }] } })],
      ["/v2/accounts/", () => ({ status: 200, body: { status: "active", balance: "1", interfaces: ["wallet_v4r2"] } })],
    ]);
    try {
      const { seqno, needsDeploy } = await wallet.readSeqno(contract.address.toString());
      assert.equal(seqno, 100099);
      assert.equal(needsDeploy, false);
    } finally {
      stub.restore();
    }
  });

  await test("throws instead of silently signing with seqno 0 when the read fails", async () => {
    const { wallet, contract } = await makeWallet();
    const stub = stubFetch([
      ["/methods/getSeqno", () => ({ status: 500, body: { error: "boom" } })],
      ["/v2/accounts/", () => ({ status: 200, body: { status: "active", balance: "1", interfaces: ["wallet_v4r2"] } })],
    ]);
    try {
      await assert.rejects(
        () => wallet.readSeqno(contract.address.toString()),
        /sequence number/,
      );
    } finally {
      stub.restore();
    }
  });

  section("jetton wallet resolution");

  await test("asks the master for the owner's wallet and persists nothing", async () => {
    const { wallet, storage, contract } = await makeWallet();
    await storage.set("account-test-account:nile-wallet:tokens", [
      {
        jetton_master_address: JETTON_MASTER.toString(),
        symbol: "USDT",
        decimals: 6,
      },
    ]);
    const derived = Address.parseRaw(`0:${"44".repeat(32)}`);
    const stub = stubFetch([
      [
        "/methods/get_wallet_address",
        () => ({
          status: 200,
          body: {
            success: true,
            exit_code: 0,
            stack: [
              {
                type: "cell",
                cell: beginCell().storeAddress(derived).endCell().toBoc().toString("hex"),
              },
            ],
          },
        }),
      ],
      walletStatesRoute({
        [derived.toString()]: { status: "active", balance: "1000000", seqno: 0 },
      }),
      [
        "/methods/get_wallet_data",
        () => ({
          status: 200,
          body: {
            success: true,
            exit_code: 0,
            stack: [
              { type: "num", num: "0x0" },
              { type: "address", address: contract.address.toString() },
              { type: "address", address: JETTON_MASTER.toString() },
            ],
          },
        }),
      ],
    ]);
    try {
      const resolved = await wallet.resolveJettonWalletAddress(JETTON_MASTER.toString());
      assert.equal(resolved, derived.toString());

      const call = stub.calls.find((entry) => entry.url.includes("get_wallet_address"));
      assert.ok(
        call.url.includes("args="),
        `the master must be asked for the owner: ${call.url}`,
      );
      assert.ok(
        !stub.calls.some((entry) => entry.url.includes("/jettons")),
        "an indexer's copy is not the source of truth for the sender's own jetton wallet",
      );

      const tokens = await wallet.listTokens();
      assert.equal(
        tokens[0].jetton_wallet_address,
        undefined,
        "a resolved address must not be written to the token record",
      );
    } finally {
      stub.restore();
    }
  });

  section("fees: the estimate is a real measurement, not an attachment");

  await test("posts the request shape toncenter actually accepts", async () => {
    const { wallet, keyPair, contract } = await makeWallet();
    const real = stubFetch([
      walletStatesRoute({
        [contract.address.toString()]: { status: "active", balance: "5000000000", seqno: 3 },
      }),
      feeRoute({ in_fwd_fee: 613201, storage_fee: 0, gas_fee: 60534, fwd_fee: 0 }),
    ]);
    try {
      const request = await wallet.buildTransferRequest({
        contract,
        keyPair,
        to: Address.parseRaw(`0:${"66".repeat(32)}`).toString(),
        amountRaw: toNano("1"),
      });
      const result = await wallet.estimateTransferFee({ request, contract });

      assert.equal(result.estimated, false, "a live estimate must not be flagged approximate");
      assert.equal(result.feeNano, withFeeHeadroom(673735n), "estimate plus headroom");

      const call = real.calls.find((entry) => entry.url.includes("/estimateFee"));
      const payload = JSON.parse(call.body);
      assert.ok(payload.address, "toncenter requires the account address");
      assert.ok(payload.body, "and the signed body as `body`, not `boc`");
      assert.equal(payload.ignore_chksig, true);
      assert.equal(payload.init_code, undefined, "a deployed wallet has no init to attach");
    } finally {
      real.restore();
    }
  });

  await test("reads the nested source_fees and adds the destination fees", async () => {
    const { wallet, keyPair, contract } = await makeWallet();
    const stub = stubFetch([
      walletStatesRoute({
        [contract.address.toString()]: { status: "active", balance: "5000000000", seqno: 1 },
      }),
      feeRoute(
        { in_fwd_fee: 1000, storage_fee: 200, gas_fee: 300, fwd_fee: 400 },
        [{ fees: { in_fwd_fee: 5000, storage_fee: 0, gas_fee: 0, fwd_fee: 0 } }],
      ),
    ]);
    try {
      const request = await wallet.buildTransferRequest({
        contract,
        keyPair,
        to: Address.parseRaw(`0:${"66".repeat(32)}`).toString(),
        amountRaw: toNano("1"),
      });
      const result = await wallet.estimateTransferFee({ request, contract });
      // 1900 source + 5000 destination, then 5% headroom.
      assert.equal(result.feeNano, withFeeHeadroom(6900n));
    } finally {
      stub.restore();
    }
  });

  await test("falls back to a fee constant, never to the attached value", async () => {
    const { wallet, keyPair, contract } = await makeWallet();
    const stub = stubFetch([
      walletStatesRoute({
        [contract.address.toString()]: { status: "active", balance: "5000000000", seqno: 1 },
      }),
      // The shape this code used to send — rejected by the real endpoint.
      ["/estimateFee", () => ({ status: 422, body: { ok: false, error: "Field is missing" } })],
    ]);
    try {
      const request = await wallet.buildTransferRequest({
        contract,
        keyPair,
        to: Address.parseRaw(`0:${"66".repeat(32)}`).toString(),
        amountRaw: 1_000_000n,
        jetton: {
          jetton_master_address: JETTON_MASTER.toString(),
          jetton_wallet_address: JETTON_WALLET.toString(),
          symbol: "USDT",
          decimals: 6,
        },
      });
      const result = await wallet.estimateTransferFee({
        request,
        contract,
        isJetton: true,
      });

      assert.equal(result.estimated, true, "a guess must be flagged as one");
      assert.equal(
        result.feeNano,
        withFeeHeadroom(FEE_FALLBACK_NANO),
        "the fallback is a fee (0.005 TON), not the 0.05 TON attachment",
      );
      assert.notEqual(result.feeNano, JETTON_ATTACHED_TON);
    } finally {
      stub.restore();
    }
  });

  await test("counts the jetton attachment once, not twice", async () => {
    const { wallet, contract } = await makeWallet();
    const attachedNano = JETTON_ATTACHED_TON;
    const snapshot = { balanceNano: attachedNano + 1_000_000n, deployed: true };
    const stub = stubFetch([
      [
        "/jettons",
        () => ({
          status: 200,
          body: {
            balances: [
              {
                jetton: { address: JETTON_MASTER.toString() },
                wallet_address: { address: JETTON_WALLET.toString() },
                balance: "1000000",
              },
            ],
          },
        }),
      ],
    ]);
    try {
      const funds = await wallet.checkTransferFunds({
        contract,
        amountRaw: 1_000n,
        jetton: {
          jetton_master_address: JETTON_MASTER.toString(),
          jetton_wallet_address: JETTON_WALLET.toString(),
          symbol: "USDT",
          decimals: 6,
        },
        attachedNano,
        feeNano: 1_000_000n,
        snapshot,
      });

      assert.equal(funds.sufficient, true);
      assert.equal(
        funds.requiredTonNano,
        attachedNano + 1_000_000n,
        "requirement is attachment + fee, with no second copy of the attachment",
      );
    } finally {
      stub.restore();
    }
  });

  await test("a sweep needs only the fee, because the message carries the balance", async () => {
    const { wallet, contract } = await makeWallet();
    const funds = await wallet.checkTransferFunds({
      contract,
      amountRaw: 1_000_000_000n,
      jetton: null,
      feeNano: 700_000n,
      snapshot: { balanceNano: 1_000_000_000n, deployed: true },
      sweep: true,
    });
    assert.equal(funds.sufficient, true);
    assert.equal(funds.requiredNano, 700_000n);
  });

  section("messages: bounce, timeout, query id, comments, hashes");

  await test("takes the bounce flag from the address the user typed", async () => {
    const { wallet, keyPair, contract } = await makeWallet();
    const destination = Address.parseRaw(`0:${"66".repeat(32)}`);
    const bounceable = destination.toString({ urlSafe: true, bounceable: true });
    const nonBounceable = destination.toString({ urlSafe: true, bounceable: false });
    const stub = stubFetch([
      walletStatesRoute({
        [contract.address.toString()]: { status: "active", balance: "5000000000", seqno: 1 },
      }),
    ]);
    try {
      const eq = await wallet.buildTransferRequest({
        contract,
        keyPair,
        to: bounceable,
        amountRaw: toNano("1"),
      });
      assert.equal(eq.isBounceable, true);
      assert.equal(decodeTransfer(eq.boc).inner.info.bounce, true);

      const uq = await wallet.buildTransferRequest({
        contract,
        keyPair,
        to: nonBounceable,
        amountRaw: toNano("1"),
      });
      assert.equal(uq.isBounceable, false, "UQ… asks for no bounce");
      assert.equal(
        decodeTransfer(uq.boc).inner.info.bounce,
        false,
        "a non-bounceable recipient must produce a non-bounceable message",
      );
    } finally {
      stub.restore();
    }
  });

  await test("sets a valid-until window instead of leaving the default", async () => {
    const { wallet, keyPair, contract } = await makeWallet();
    const stub = stubFetch([
      walletStatesRoute({
        [contract.address.toString()]: { status: "active", balance: "5000000000", seqno: 1 },
      }),
    ]);
    try {
      const now = Math.floor(Date.now() / 1000);
      const result = await wallet.buildTransferRequest({
        contract,
        keyPair,
        to: Address.parseRaw(`0:${"66".repeat(32)}`).toString(),
        amountRaw: toNano("1"),
      });
      const { validUntil } = decodeTransfer(result.boc);
      assert.ok(validUntil > now + 500, `expected a ~600s window, got ${validUntil - now}s`);
    } finally {
      stub.restore();
    }
  });

  await test("carries a text comment as an op-0 body", async () => {
    const { wallet, keyPair, contract } = await makeWallet();
    const stub = stubFetch([
      walletStatesRoute({
        [contract.address.toString()]: { status: "active", balance: "5000000000", seqno: 1 },
      }),
    ]);
    try {
      const result = await wallet.buildTransferRequest({
        contract,
        keyPair,
        to: Address.parseRaw(`0:${"66".repeat(32)}`).toString(),
        amountRaw: toNano("1"),
        comment: "invoice 42",
      });
      const { inner } = decodeTransfer(result.boc);
      const body = inner.body.beginParse();
      assert.equal(body.loadUint(32), 0, "op 0 is a text comment");
      assert.equal(body.loadStringTail(), "invoice 42");
    } finally {
      stub.restore();
    }
  });

  await test("packs a comment longer than one cell into the snake form", () => {
    const long = "x".repeat(300);
    const cell = commentToCell(long);

    // The snake form is a chain: each cell references the one after it, so the
    // head cell has a single ref and the tail has none.
    let cursor = cell;
    let depth = 1;
    while (cursor.refs.length > 0) {
      assert.equal(cursor.refs.length, 1, "the chain is linear, not a fan-out");
      cursor = cursor.refs[0];
      depth += 1;
    }
    assert.ok(depth >= 2, `300 bytes cannot fit in the head cell (depth ${depth})`);

    const slice = cell.beginParse();
    assert.equal(slice.loadUint(32), 0);
    let text = slice.loadStringTail();
    while (slice.remainingRefs > 0) {
      const next = slice.loadRef().beginParse();
      text += next.loadStringTail();
    }
    assert.equal(text, long, "the comment must survive the round trip intact");
  });

  await test("uses a fresh query id per jetton body", () => {
    const first = generateQueryId();
    const second = generateQueryId();
    assert.ok(first >= 0n && first < 2n ** 64n, "query ids are uint64");
    assert.ok(first !== second, "two ids must not collide");
  });

  await test("the normalized message hash ignores stateInit", async () => {
    const { keyPair, contract } = await makeWallet();
    const destination = Address.parseRaw(`0:${"66".repeat(32)}`);
    const body = contract.createTransfer({
      seqno: 0,
      secretKey: keyPair.secretKey,
      sendMode: 3,
      messages: [
        internal({
          to: destination,
          value: toNano("1"),
          bounce: true,
          body: beginCell().endCell(),
        }),
      ],
    });

    const withoutInit = beginCell()
      .store(storeMessage(external({ to: contract.address, body })))
      .endCell();
    const withInit = beginCell()
      .store(storeMessage(external({ to: contract.address, init: contract.init, body })))
      .endCell();

    assert.equal(
      externalInHashNormalized({ to: contract.address, body }),
      withoutInit.hash().toString("hex"),
      "the normalized hash must be the documented external-in layout",
    );
    assert.notEqual(
      externalInHashNormalized({ to: contract.address, body }),
      withInit.hash().toString("hex"),
      "and must not move when stateInit is attached",
    );
  });

  await test("sweep mode carries the remaining balance", async () => {
    const { wallet, keyPair, contract } = await makeWallet();
    const stub = stubFetch([
      walletStatesRoute({
        [contract.address.toString()]: { status: "active", balance: "5000000000", seqno: 2 },
      }),
    ]);
    try {
      const result = await wallet.buildTransferRequest({
        contract,
        keyPair,
        to: Address.parseRaw(`0:${"66".repeat(32)}`).toString(),
        amountRaw: 4_999_999_999n,
        sweep: true,
      });
      assert.equal(result.sendMode, SWEEP_SEND_MODE);
      assert.equal(decodeTransfer(result.boc).sendMode, SWEEP_SEND_MODE);
    } finally {
      stub.restore();
    }
  });

  section("errors: TVM exit codes are classified by number");

  await test("recognizes a seqno mismatch and an expired window", () => {
    assert.equal(isSeqnoMismatchError("exit_code: 33"), true);
    assert.equal(isSeqnoMismatchError("exitcode=133"), true);
    assert.equal(isExpiredTransferError("exit_code: 35"), true);
    assert.equal(isExpiredTransferError("exitcode=136"), true);
    assert.equal(isSeqnoMismatchError("exit_code: 35"), false);
    assert.equal(isExpiredTransferError("exit_code: 33"), false);
    assert.equal(isSeqnoMismatchError("exit_code: -13"), false);
  });

  await test("maps a rejected broadcast to a retryable message", async () => {
    const { wallet } = await makeWallet();
    const stub = stubFetch([
      [
        "/blockchain/message",
        () => ({ status: 400, body: { error: "failed, exit_code: 33" } }),
      ],
    ]);
    try {
      await assert.rejects(
        () => wallet.broadcastTransfer(beginCell().endCell().toBoc().toString("base64")),
        /sequence number moved/,
      );
    } finally {
      stub.restore();
    }
  });

  section("wallets: contract version");

  await test("normalizes the version strings indexers use", () => {
    assert.equal(normalizeWalletPlatform("wallet_v4r2"), "v4r2");
    assert.equal(normalizeWalletPlatform("wallet v3 r2"), "v3r2");
    assert.equal(normalizeWalletPlatform("wallet v5 r1"), "w5");
    assert.equal(normalizeWalletPlatform("nft_collection"), null);
  });

  await test("derives a different address per version from one key", () => {
    const key = Buffer.alloc(32, 9);
    const addresses = WALLET_PLATFORMS.map(
      (platform) => `${platform}:${buildWalletContract(key, platform).address.toRawString()}`,
    );
    assert.equal(new Set(addresses).size, WALLET_PLATFORMS.length);
    assert.equal(
      buildWalletContract(key, DEFAULT_WALLET_PLATFORM).address.toRawString(),
      WalletContractV4.create({ workchain: 0, publicKey: key }).address.toRawString(),
    );
  });

  await test("picks the version whose address is deployed on-chain", async () => {
    const { wallet } = await makeWallet();
    const key = Buffer.alloc(32, 21);
    const v3 = buildWalletContract(key, "v3r2");
    const v4 = buildWalletContract(key, "v4r2");
    const w5 = buildWalletContract(key, "w5");

    const stub = stubFetch([
      walletStatesRoute({
        [v3.address.toString()]: { status: "uninit", balance: "0" },
        [v4.address.toString()]: { status: "uninit", balance: "0" },
        [w5.address.toString()]: { status: "active", balance: "123", seqno: 4 },
      }),
    ]);
    try {
      const detected = await wallet.detectPlatform(key.toString("hex"));
      assert.equal(detected.platform, "w5");
      assert.equal(detected.deployed, true);

      const calls = stub.calls.filter((entry) => entry.url.includes("/walletStates"));
      assert.equal(calls.length, 1, "one batched request for every candidate");
      assert.ok(calls[0].url.includes("%2C") || calls[0].url.includes(","));
    } finally {
      stub.restore();
    }
  });

  await test("refuses to sign with a version the chain disagrees with", async () => {
    const { wallet, keyPair, contract } = await makeWallet();
    const stub = stubFetch([
      walletStatesRoute({
        [contract.address.toString()]: {
          status: "active",
          balance: "5000000000",
          seqno: 3,
          walletType: "wallet v5 r1",
        },
      }),
    ]);
    try {
      await assert.rejects(
        () =>
          wallet.buildTransferRequest({
            contract,
            keyPair,
            to: Address.parseRaw(`0:${"66".repeat(32)}`).toString(),
            amountRaw: toNano("1"),
            platform: "v4r2",
          }),
        /reports this wallet as w5/,
        "a v4 signature for a v5 contract can never land",
      );
    } finally {
      stub.restore();
    }
  });

  await test("signs when the chain agrees, and when it cannot be compared", async () => {
    const { wallet, keyPair, contract } = await makeWallet();
    const destination = Address.parseRaw(`0:${"66".repeat(32)}`).toString();
    const agreeing = stubFetch([
      walletStatesRoute({
        [contract.address.toString()]: { status: "active", balance: "5000000000", seqno: 3 },
      }),
    ]);
    try {
      const request = await wallet.buildTransferRequest({
        contract,
        keyPair,
        to: destination,
        amountRaw: toNano("1"),
        platform: "v4r2",
      });
      assert.equal(request.platform, "v4r2");
    } finally {
      agreeing.restore();
    }

    // No local version recorded (a wallet created by an older build) and no
    // interface from the provider: neither side may block a send.
    assert.equal(signingPlatformConflict(null, "v4r2"), null);
    assert.equal(signingPlatformConflict("v4r2", null), null);
    assert.equal(signingPlatformConflict("v4r2", "v4r2"), null);
    assert.match(signingPlatformConflict("w5", "v4r2"), /re-import/);
  });

  section("wallet states: batched read");

  await test("answers for every address from one request", async () => {
    const a = Address.parseRaw(`0:${"11".repeat(32)}`);
    const b = Address.parseRaw(`0:${"22".repeat(32)}`);
    const c = Address.parseRaw(`0:${"33".repeat(32)}`);
    const stub = stubFetch([
      walletStatesRoute({
        [a.toString()]: { status: "active", balance: "100", seqno: 7 },
        [b.toString()]: { status: "uninit", balance: "0" },
      }),
    ]);
    try {
      const states = await fetchWalletStates([a.toString(), b.toString(), c.toString()]);
      assert.equal(stub.calls.length, 1, "one request, not one per address");
      assert.equal(states.get(a.toString()).seqno, 7);
      assert.equal(states.get(a.toString()).deployed, true);
      assert.equal(states.get(b.toString()).deployed, false);
      assert.equal(
        states.get(c.toString()).balanceNano,
        0n,
        "an address the indexer has never seen is an empty account, not a missing key",
      );
      assert.equal(states.get(c.toString()).deployed, false);
    } finally {
      stub.restore();
    }
  });

  section("jetton wallet: derived, then verified against the chain");

  await test("derives the wallet address from the master", async () => {
    const { wallet, contract } = await makeWallet();
    const derived = Address.parseRaw(`0:${"77".repeat(32)}`);
    const stub = stubFetch([
      [
        "/methods/get_wallet_address",
        () => ({
          status: 200,
          body: {
            success: true,
            exit_code: 0,
            // tonapi reports cell stack entries as hex-serialized BOCs.
            stack: [
              {
                type: "cell",
                cell: beginCell().storeAddress(derived).endCell().toBoc().toString("hex"),
              },
            ],
          },
        }),
      ],
      walletStatesRoute({
        [derived.toString()]: { status: "active", balance: "1000000", seqno: 0 },
      }),
      [
        "/methods/get_wallet_data",
        () => ({
          status: 200,
          body: {
            success: true,
            exit_code: 0,
            stack: [
              { type: "num", num: "0x0" },
              { type: "address", address: contract.address.toString() },
              { type: "address", address: JETTON_MASTER.toString() },
            ],
          },
        }),
      ],
    ]);
    try {
      const resolved = await wallet.resolveJettonWalletAddress(JETTON_MASTER.toString());
      assert.equal(resolved, derived.toString());
    } finally {
      stub.restore();
    }
  });

  await test("refuses a wallet whose minter does not match the master", async () => {
    const { wallet, contract } = await makeWallet();
    const derived = Address.parseRaw(`0:${"77".repeat(32)}`);
    const stub = stubFetch([
      [
        "/methods/get_wallet_address",
        () => ({
          status: 200,
          body: {
            success: true,
            exit_code: 0,
            stack: [
              {
                type: "cell",
                cell: beginCell().storeAddress(derived).endCell().toBoc().toString("hex"),
              },
            ],
          },
        }),
      ],
      walletStatesRoute({
        [derived.toString()]: { status: "active", balance: "1000000", seqno: 0 },
      }),
      [
        "/methods/get_wallet_data",
        () => ({
          status: 200,
          body: {
            success: true,
            exit_code: 0,
            stack: [
              { type: "num", num: "0x0" },
              { type: "address", address: contract.address.toString() },
              { type: "address", address: Address.parseRaw(`0:${"99".repeat(32)}`).toString() },
            ],
          },
        }),
      ],
    ]);
    try {
      await assert.rejects(
        () => wallet.resolveJettonWalletAddress(JETTON_MASTER.toString()),
        /Could not verify this token's wallet address/,
      );
    } finally {
      stub.restore();
    }
  });

  await test("never reuses a persisted jetton wallet address", async () => {
    const { wallet, storage, contract } = await makeWallet();
    // A stale record from an older build must not be trusted.
    await storage.set("account-test-account:nile-wallet:tokens", [
      {
        jetton_master_address: JETTON_MASTER.toString(),
        symbol: "USDT",
        decimals: 6,
        jetton_wallet_address: Address.parseRaw(`0:${"55".repeat(32)}`).toString(),
      },
    ]);
    const derived = Address.parseRaw(`0:${"77".repeat(32)}`);
    const stub = stubFetch([
      [
        "/methods/get_wallet_address",
        () => ({
          status: 200,
          body: {
            success: true,
            exit_code: 0,
            stack: [
              {
                type: "cell",
                cell: beginCell().storeAddress(derived).endCell().toBoc().toString("hex"),
              },
            ],
          },
        }),
      ],
      walletStatesRoute({ [derived.toString()]: { status: "uninit", balance: "0" } }),
    ]);
    try {
      const resolved = await wallet.resolveJettonWalletAddress(JETTON_MASTER.toString());
      assert.equal(resolved, derived.toString(), "the chain wins over the cache");
      const tokens = await wallet.listTokens();
      assert.equal(
        tokens[0].jetton_wallet_address,
        Address.parseRaw(`0:${"55".repeat(32)}`).toString(),
        "the resolver must not rewrite the record either",
      );
    } finally {
      stub.restore();
    }
  });

  section("send path: end to end through the wallet API");

  await test("estimates on a single wallet-state snapshot", async () => {
    installBridge();
    const accountId = "it-estimate";
    const words = await mnemonicNew(24);
    const keyPair = await mnemonicToPrivateKey(words);
    const contract = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
    await nileWallet.createWallet("estimate");
    const wallets = await nileWallet.listWallets();
    const id = wallets[wallets.length - 1].id;
    const map = globalThis.window.nilevault;
    await map.kvSet(`account-${id}:nile-wallet`, {
      address: contract.address.toString({ urlSafe: true, bounceable: false }),
      rawAddress: contract.address.toRawString(),
      publicKey: keyPair.publicKey.toString("hex"),
      platform: "v4r2",
    });

    const recipient = Address.parseRaw(`0:${"66".repeat(32)}`);
    const stub = stubFetch([
      walletStatesRoute({
        [contract.address.toString()]: { status: "active", balance: "5000000000", seqno: 9 },
        [recipient.toString()]: { status: "active", balance: "1000000" },
      }),
      feeRoute({ in_fwd_fee: 600000, storage_fee: 0, gas_fee: 50000, fwd_fee: 0 }),
    ]);
    try {
      const estimate = await nileWallet.estimateTransfer(id, {
        kind: "ton",
        to: recipient.toString({ urlSafe: true, bounceable: true }),
        amount: "1",
      });
      assert.equal(estimate.feeEstimated, false, "estimated === false on a live estimate");
      assert.equal(estimate.feeNano, withFeeHeadroom(650000n).toString());
      assert.equal(estimate.insufficient, null);
      assert.equal(estimate.isBounceable, true);
      assert.equal(estimate.needsDeploy, false);
      assert.equal(estimate.attachedNano, "0");
      assert.equal(estimate.sendMode, 3);

      const stateCalls = stub.calls.filter((entry) => entry.url.includes("/walletStates"));
      assert.equal(stateCalls.length, 2, "one snapshot per address, sender and recipient");
    } finally {
      stub.restore();
    }
  });

  await test("an estimate names the contract a jetton transfer is addressed to", async () => {
    installBridge();
    const words = await mnemonicNew(24);
    const keyPair = await mnemonicToPrivateKey(words);
    const contract = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
    const id = "acct-it-jetton-target";
    await globalThis.window.nilevault.kvSet(`account-${id}:nile-wallet`, {
      address: contract.address.toString({ urlSafe: true, bounceable: false }),
      rawAddress: contract.address.toRawString(),
      publicKey: keyPair.publicKey.toString("hex"),
      platform: "v4r2",
    });

    const recipient = Address.parseRaw(`0:${"6c".repeat(32)}`);
    const derived = Address.parseRaw(`0:${"8b".repeat(32)}`);
    const master = Address.parseRaw(`0:${"8c".repeat(32)}`);
    const stub = stubFetch([
      [
        "/methods/get_wallet_address",
        () => ({
          status: 200,
          body: {
            success: true,
            exit_code: 0,
            stack: [
              {
                type: "cell",
                cell: beginCell().storeAddress(derived).endCell().toBoc().toString("hex"),
              },
            ],
          },
        }),
      ],
      walletStatesRoute({
        [contract.address.toString()]: { status: "active", balance: "5000000000", seqno: 4 },
        [recipient.toString()]: { status: "active", balance: "1000000" },
        [derived.toString()]: { status: "active", balance: "1000000", seqno: 0 },
      }),
      [
        "/methods/get_wallet_data",
        () => ({
          status: 200,
          body: {
            success: true,
            exit_code: 0,
            stack: [
              { type: "num", num: "0x0" },
              { type: "address", address: contract.address.toString() },
              { type: "address", address: master.toString() },
            ],
          },
        }),
      ],
      [
        "/jettons",
        () => ({
          status: 200,
          body: {
            balances: [
              {
                jetton: { address: master.toString() },
                wallet_address: { address: derived.toString() },
                balance: "1000000000",
              },
            ],
          },
        }),
      ],
      feeRoute({ in_fwd_fee: 600000, storage_fee: 0, gas_fee: 50000, fwd_fee: 0 }),
    ]);
    try {
      const estimate = await nileWallet.estimateTransfer(id, {
        kind: "jetton",
        token: {
          jetton_master_address: master.toString(),
          symbol: "USDT",
          decimals: 6,
        },
        to: recipient.toString({ urlSafe: true, bounceable: true }),
        amount: "1",
      });

      assert.equal(
        estimate.jettonWallet,
        derived.toString(),
        "the confirmation has to be able to name the contract the message is sent to",
      );
      assert.equal(estimate.jettonMaster, master.toString());
      assert.notEqual(
        estimate.jettonWallet,
        estimate.to,
        "the recipient is inside the body, not the message target",
      );
      assert.equal(estimate.attachedNano, JETTON_ATTACHED_TON.toString());
    } finally {
      stub.restore();
    }
  });

  await test("refuses a bounceable transfer to an account with no code", async () => {
    installBridge();
    const accountId = "it-inactive";
    const words = await mnemonicNew(24);
    const keyPair = await mnemonicToPrivateKey(words);
    const contract = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
    const id = `acct-${accountId}`;
    await globalThis.window.nilevault.kvSet(`account-${id}:nile-wallet`, {
      address: contract.address.toString({ urlSafe: true, bounceable: false }),
      rawAddress: contract.address.toRawString(),
      publicKey: keyPair.publicKey.toString("hex"),
      platform: "v4r2",
    });

    const recipient = Address.parseRaw(`0:${"68".repeat(32)}`);
    const stub = stubFetch([
      walletStatesRoute({
        [contract.address.toString()]: { status: "active", balance: "5000000000", seqno: 1 },
      }),
      feeRoute({ in_fwd_fee: 1, storage_fee: 0, gas_fee: 0, fwd_fee: 0 }),
    ]);
    try {
      await assert.rejects(
        () =>
          nileWallet.estimateTransfer(id, {
            kind: "ton",
            to: recipient.toString({ urlSafe: true, bounceable: true }),
            amount: "1",
          }),
        /no code on-chain/,
      );

      // The non-bounceable form is the documented escape hatch and must work.
      const estimate = await nileWallet.estimateTransfer(id, {
        kind: "ton",
        to: recipient.toString({ urlSafe: true, bounceable: false }),
        amount: "1",
      });
      assert.equal(estimate.isBounceable, false);
      assert.equal(estimate.insufficient, null);
    } finally {
      stub.restore();
    }
  });

  await test("refuses a testnet address on mainnet", async () => {
    installBridge();
    const words = await mnemonicNew(24);
    const keyPair = await mnemonicToPrivateKey(words);
    const contract = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
    const id = "acct-it-testnet";
    await globalThis.window.nilevault.kvSet(`account-${id}:nile-wallet`, {
      address: contract.address.toString({ urlSafe: true, bounceable: false }),
      rawAddress: contract.address.toRawString(),
      publicKey: keyPair.publicKey.toString("hex"),
      platform: "v4r2",
    });

    const testnet = Address.parse(EQ_ADDR).toString({
      urlSafe: true,
      bounceable: true,
      testOnly: true,
    });
    const stub = stubFetch([walletStatesRoute({})]);
    try {
      await assert.rejects(
        () => nileWallet.estimateTransfer(id, { kind: "ton", to: testnet, amount: "1" }),
        /testnet address/,
      );
    } finally {
      stub.restore();
    }
  });

  await test("two overlapping sends take different sequence numbers", async () => {
    installBridge();
    await nileWallet.unlock("concurrency-passphrase");
    await nileWallet.createWallet("concurrent");
    const wallets = await nileWallet.listWallets();
    const id = wallets[wallets.length - 1].id;
    const generated = await nileWallet.generate(id);
    const contract = WalletContractV4.create({
      workchain: 0,
      publicKey: Buffer.from(generated.publicKey, "hex"),
    });

    const recipient = Address.parseRaw(`0:${"6a".repeat(32)}`);
    let chainSeqno = 0;
    let broadcasts = 0;

    const stub = stubFetch([
      [
        "/walletStates",
        (url) => {
          const query = decodeURIComponent(String(url).split("address=")[1] || "");
          const wallets1 = query.split(",").map((asked) => {
            const address = asked.trim();
            const isMine = sameAddress(address, contract.address.toString());
            return {
              address: Address.parse(address).toRawString(),
              balance: "5000000000",
              status: "active",
              seqno: isMine ? chainSeqno : 0,
              is_wallet: true,
              wallet_type: "wallet v4 r2",
            };
          });
          return { status: 200, body: { wallets: wallets1, address_book: {} } };
        },
      ],
      feeRoute({ in_fwd_fee: 500000, storage_fee: 0, gas_fee: 1000, fwd_fee: 0 }),
      [
        "/blockchain/message",
        () => {
          broadcasts += 1;
          chainSeqno += 1; // the chain executes it immediately
          return { status: 200, body: { message_hash: `hash-${broadcasts}` } };
        },
      ],
      ["/blockchain/messages/", () => ({ status: 200, body: { in_progress: false } })],
    ]);

    resetTransferQueue();
    const settled = [];
    const unsubscribe = nileWallet.onTransferSettled((payload) => settled.push(payload));

    try {
      const params = {
        kind: "ton",
        to: recipient.toString({ urlSafe: true, bounceable: true }),
        amount: "1",
      };
      const [first, second] = await Promise.all([
        nileWallet.sendTransfer(id, params),
        nileWallet.sendTransfer(id, params),
      ]);

      assert.equal(broadcasts, 2, "both transfers must be broadcast");
      assert.deepEqual(
        [first.seqno, second.seqno].sort((a, b) => a - b),
        [0, 1],
        "the second send must sign the sequence number the first one left behind",
      );
      assert.notEqual(first.hash, second.hash);

      // The background confirmation attaches to the same queue, so by the time
      // both sends have returned the seqno watch has settled both of them.
      for (let i = 0; i < 50 && settled.length < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(settled.length, 2, "each transfer reports its on-chain outcome");
      assert.ok(settled.every((entry) => entry.txStatus === "confirmed"));
    } finally {
      unsubscribe();
      stub.restore();
      resetTransferQueue();
    }
  });

  section("results");

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const { name, error } of failures) {
      console.log(`\n\u2717 ${name}\n${error.stack}`);
    }
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
