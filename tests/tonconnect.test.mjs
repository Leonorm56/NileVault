/**
 * TON Connect link tests.
 *
 * The failure these pin down shipped: pasting a `tc://` link, the approval sheet
 * opened knowing nothing about the request, and pressing Approve died with
 * "Cannot read properties of undefined (reading 'length')" — `hexToBytes` inside
 * the box encryption was handed an undefined session key, because the prepared
 * request arrived double-wrapped (`{status, prepared}`) and every field the
 * modal and the signing path read was therefore undefined.
 *
 * So the assertions here are about the *shape that crosses the UI boundary*: a
 * parsed link must expose `dAppPubKey`/`manifest`/`items` at the top level, and
 * a request that is not shaped that way must fail with a readable message rather
 * than a TypeError. Two real links are replayed verbatim — including the one
 * that carries an extra `trace_id` param — and the approve/reject paths are
 * exercised end to end by decrypting what actually goes onto the bridge.
 *
 * Deterministic: fetch and EventSource are stubbed, so no network is touched.
 *
 * Run with `npm test` (esbuild bundles the ESM sources; the app's package.json is
 * deliberately not `type: module` because the main process is CJS).
 */

import assert from "node:assert/strict";

import { base64 } from "@scure/base";
import { Address } from "@ton/core";
import { sha256 } from "@ton/crypto";
import nacl from "tweetnacl";

/* ── the two real links from the bug report ───────────────────────────────── */

const LINK_TRACE_FREE =
  "tc://?v=2&id=dcb2bbdf5390e3a8a21e4e545532dae678d0746434a4306de271455ba16a6b00&r=%7B%22manifestUrl%22%3A%22https%3A%2F%2Fsixseven-dev-tgops.s3.eu-central-1.amazonaws.com%2Ftonconnect%2Fton-manifest.json%22%2C%22items%22%3A%5B%7B%22name%22%3A%22ton_addr%22%7D%2C%7B%22name%22%3A%22ton_proof%22%2C%22payload%22%3A%226f8f6532c4672aec000000006aab7be5a3cdf6409423025d57ddc8fd9f44eaaf4798fc9498524e7d0d16941bd54c8988%22%7D%5D%7D";

const LINK_WITH_TRACE_ID =
  "tc://?v=2&id=a5350a20b2121748cd703da51976526d2bd0fabaf96b4078eeb24f36167f3578&trace_id=01a0addf-e14c-771e-8fe4-9e2828960d4a&r=%7B%22manifestUrl%22%3A%22https%3A%2F%2Fapp.rignite.app%2Ftonconnect-manifest.json%22%2C%22items%22%3A%5B%7B%22name%22%3A%22ton_addr%22%7D%2C%7B%22name%22%3A%22ton_proof%22%2C%22payload%22%3A%226a33e002435035329e97ca8b603dd5bd9e4bdad517fae2230c1e8a4746c8744d%22%7D%5D%7D";

const PROOF_PAYLOAD =
  "6a33e002435035329e97ca8b603dd5bd9e4bdad517fae2230c1e8a4746c8744d";

const MANIFEST_LINK_1 =
  "https://sixseven-dev-tgops.s3.eu-central-1.amazonaws.com/tonconnect/ton-manifest.json";
const MANIFEST_LINK_2 = "https://app.rignite.app/tonconnect-manifest.json";
/** Serves a body that is valid JSON but not an object — must not be trusted. */
const MANIFEST_BROKEN = "https://broken.example/tonconnect-manifest.json";

/* ── harness ──────────────────────────────────────────────────────────────── */

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

/**
 * The renderer reaches its key-value store through `window.nilevault`, read
 * lazily on each call. Stubbing it gives the session store somewhere to write,
 * which is what makes the approve → session-persisted assertion meaningful.
 */
function installBridge() {
  const store = new Map();
  globalThis.window = {
    nilevault: {
      kvGet: async (key) => (store.has(key) ? structuredClone(store.get(key)) : undefined),
      kvSet: async (key, value) => {
        store.set(key, structuredClone(value));
        return { ok: true };
      },
      kvRemove: async (key) => {
        store.delete(key);
        return { ok: true };
      },
      kvGetAll: async () => Object.fromEntries(store),
    },
  };
}

/** Every request the wallet published to the bridge, in order. */
const published = [];

/**
 * Stub the network: manifests are served from a local table, bridge publishes
 * are recorded, and the SSE endpoint answers with an empty stream.
 */
function installNetwork({ manifests }) {
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);

    if (href.includes("/bridge/message")) {
      published.push({ url: href, body: init.body });
      return { ok: true, status: 200, text: async () => "" };
    }
    if (href.includes("/bridge/events")) {
      return { ok: true, status: 200, text: async () => "" };
    }
    if (href in manifests) {
      const entry = manifests[href];
      if (entry.status && entry.status !== 200) {
        return { ok: false, status: entry.status, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => entry.body };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
}

/**
 * Minimal EventSource that reports a successful connection, so `subscribe()`
 * settles on the first bridge without falling back to the polling loop (which
 * would keep the process alive).
 */
function installEventSource() {
  class StubEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      setTimeout(() => {
        if (!this.closed) this.onopen?.();
      }, 0);
    }

    close() {
      this.closed = true;
    }
  }
  globalThis.EventSource = StubEventSource;
}

/** Build a `tc://` link the way a dApp would, for a session key we control. */
function buildLink({ dAppPubKey, manifestUrl, items, extra = {} }) {
  const request = { manifestUrl, items };
  const params = new URLSearchParams({
    v: "2",
    id: dAppPubKey,
    ...extra,
    r: JSON.stringify(request),
  });
  return `tc://?${params.toString()}`;
}

function hexToBytes(hex) {
  const clean = hex.length % 2 ? "0" + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Pull `client_id`/`to` out of a bridge publish URL. */
function bridgeParams(url) {
  const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
  return {
    clientId: query.get("client_id"),
    to: query.get("to"),
    ttl: query.get("ttl"),
  };
}

/** Decrypt a published bridge body the way the dApp would. */
function openEnvelope({ url, body }, dAppSecretKey) {
  const { clientId, to } = bridgeParams(url);
  const full = base64.decode(body);
  const message = nacl.box.open(
    full.slice(24),
    full.slice(0, 24),
    hexToBytes(clientId),
    dAppSecretKey,
  );
  assert.ok(message, "the published body is decryptable by the dApp");
  return { to, event: JSON.parse(new TextDecoder().decode(message)) };
}

/**
 * Re-derive the ton_proof signing message from the spec layout and check the
 * signature against the wallet's own public key — an independent verification,
 * not a re-run of the implementation.
 */
async function verifyProofSignature(proof, tonAddrItem) {
  const address = Address.parseRaw(tonAddrItem.address);
  const domainBuffer = Buffer.from(proof.domain.value, "utf8");

  const domainLen = Buffer.alloc(4);
  domainLen.writeUInt32LE(domainBuffer.length);
  const workchain = Buffer.alloc(4);
  workchain.writeInt32BE(address.workChain);
  const timestamp = Buffer.alloc(8);
  timestamp.writeUInt32LE(proof.timestamp & 0xffffffff, 0);
  timestamp.writeUInt32LE(Math.floor(proof.timestamp / 0x100000000), 4);

  const message = Buffer.concat([
    Buffer.from("ton-proof-item-v2/", "utf8"),
    workchain,
    address.hash,
    domainLen,
    domainBuffer,
    timestamp,
    Buffer.from(proof.payload, "utf8"),
  ]);
  const messageHash = await sha256(message);
  const fullMessage = Buffer.concat([
    Buffer.from([0xff, 0xff]),
    Buffer.from("ton-connect", "utf8"),
    messageHash,
  ]);

  return nacl.sign.detached.verify(
    new Uint8Array(await sha256(fullMessage)),
    base64.decode(proof.signature),
    hexToBytes(tonAddrItem.publicKey),
  );
}

/* ── run ──────────────────────────────────────────────────────────────────── */

async function main() {
  installBridge();
  installEventSource();

  const { mnemonicNew, mnemonicToPrivateKey } = await import("@ton/crypto");
  const { WalletContractV4 } = await import("@ton/ton");
  const { default: nileWallet } = await import("../src/renderer/lib/nileWallet.js");
  const { default: nileWalletClient, NileWalletLockedError } = await import(
    "../src/renderer/lib/nileWalletClient.js"
  );
  const { default: connectManager } = await import(
    "../src/renderer/lib/nileWalletConnectManager.js"
  );
  const { default: NileWalletConnect } = await import(
    "../src/renderer/lib/NileWalletConnect.js"
  );

  installNetwork({
    manifests: {
      [MANIFEST_LINK_1]: {
        body: {
          url: "https://prod.6sixseven7.club",
          name: "Six Seven Club",
          iconUrl: "https://sixseven-dev-tgops.s3.eu-central-1.amazonaws.com/tonconnect/67logo.jpg",
        },
      },
      [MANIFEST_LINK_2]: {
        body: {
          url: "https://app.rignite.app",
          name: "Rignite",
          iconUrl: "https://app.rignite.app/icon.png",
        },
      },
      [MANIFEST_BROKEN]: { body: null },
    },
  });

  /* ── one shared vault, built once ───────────────────────────────────────── */

  const VAULT_PASS = "vault-passphrase-1";
  const created = await nileWallet.createWallet("Main");
  const ACCOUNT_ID = created.wallet.id;

  await nileWallet.unlock(VAULT_PASS);
  const generated = await nileWallet.generate(ACCOUNT_ID);
  const WALLET_ADDRESS = Address.parse(generated.address).toRawString();

  /** A dApp session keypair the test owns, so it can decrypt the reply. */
  function newDApp() {
    const keyPair = nacl.box.keyPair();
    const publicKey = Buffer.from(keyPair.publicKey).toString("hex");
    return { keyPair, publicKey };
  }

  /* ── parsing ────────────────────────────────────────────────────────────── */

  section("connect link: parsing");

  await test("a real link parses with no trace_id", async () => {
    const prepared = await connectManager.parseLink(ACCOUNT_ID, LINK_TRACE_FREE);
    assert.equal(
      prepared.dAppPubKey,
      "dcb2bbdf5390e3a8a21e4e545532dae678d0746434a4306de271455ba16a6b00",
    );
    assert.equal(prepared.manifestUrl, MANIFEST_LINK_1);
    assert.equal(prepared.traceId, null);
    assert.deepEqual(prepared.items, [
      { name: "ton_addr" },
      {
        name: "ton_proof",
        payload:
          "6f8f6532c4672aec000000006aab7be5a3cdf6409423025d57ddc8fd9f44eaaf4798fc9498524e7d0d16941bd54c8988",
      },
    ]);
  });

  await test("a real link with an extra trace_id parses identically", async () => {
    const prepared = await connectManager.parseLink(ACCOUNT_ID, LINK_WITH_TRACE_ID);
    assert.equal(
      prepared.dAppPubKey,
      "a5350a20b2121748cd703da51976526d2bd0fabaf96b4078eeb24f36167f3578",
    );
    assert.equal(prepared.manifestUrl, MANIFEST_LINK_2);
    // The unexpected param is kept for diagnostics and changes nothing else.
    assert.equal(prepared.traceId, "01a0addf-e14c-771e-8fe4-9e2828960d4a");
    assert.deepEqual(
      prepared.items.map((item) => item.name),
      ["ton_addr", "ton_proof"],
    );
  });

  await test("extra params do not shift which value lands in the request", async () => {
    const withExtras = await connectManager.parseLink(
      ACCOUNT_ID,
      `${LINK_TRACE_FREE}&ret=https://example.com%2Fdone&unknown=1&v=2`,
    );
    const baseline = await connectManager.parseLink(ACCOUNT_ID, LINK_TRACE_FREE);
    assert.deepEqual(withExtras.items, baseline.items);
    assert.equal(withExtras.manifestUrl, baseline.manifestUrl);
    assert.equal(withExtras.ret, "https://example.com/done");
  });

  await test("regression: the parsed request is flat, not wrapped in `prepared`", async () => {
    const prepared = await connectManager.parseLink(ACCOUNT_ID, LINK_TRACE_FREE);
    assert.equal(prepared.prepared, undefined, "no nested prepared object");
    assert.ok(prepared.dAppPubKey, "dAppPubKey is readable at the top level");
    assert.ok(prepared.manifest?.name, "manifest is readable at the top level");
    assert.ok(Array.isArray(prepared.items), "items is readable at the top level");
  });

  await test("the requesting app's name and icon come from its manifest", async () => {
    const prepared = await connectManager.parseLink(ACCOUNT_ID, LINK_WITH_TRACE_ID);
    assert.equal(prepared.manifest.name, "Rignite");
    assert.equal(prepared.manifest.iconUrl, "https://app.rignite.app/icon.png");
    assert.equal(prepared.manifest.url, "https://app.rignite.app");
  });

  await test("a manifest that is not an object falls back to the host", async () => {
    const prepared = await connectManager.parseLink(
      ACCOUNT_ID,
      buildLink({
        dAppPubKey: newDApp().publicKey,
        manifestUrl: MANIFEST_BROKEN,
        items: [{ name: "ton_addr" }],
      }),
    );
    assert.equal(prepared.manifest.name, "broken.example");
    assert.equal(prepared.manifest.iconUrl, null);
    assert.equal(prepared.manifest.url, MANIFEST_BROKEN);
  });

  await test("an unreachable manifest still yields a connectable request", async () => {
    const url = "https://offline.example/tonconnect-manifest.json";
    const prepared = await connectManager.parseLink(
      ACCOUNT_ID,
      buildLink({
        dAppPubKey: newDApp().publicKey,
        manifestUrl: url,
        items: [{ name: "ton_addr" }],
      }),
    );
    assert.equal(prepared.manifest.name, "offline.example");
    assert.equal(prepared.status, true);
  });

  await test("a link that asks only for ton_addr still carries ton_addr", async () => {
    const prepared = await connectManager.parseLink(
      ACCOUNT_ID,
      buildLink({
        dAppPubKey: newDApp().publicKey,
        manifestUrl: MANIFEST_LINK_2,
        items: [{ name: "ton_addr" }],
      }),
    );
    assert.deepEqual(prepared.items, [{ name: "ton_addr" }]);
  });

  await test("a link with no items list defaults to ton_addr", async () => {
    const dApp = newDApp();
    const prepared = await connectManager.parseLink(
      ACCOUNT_ID,
      buildLink({ dAppPubKey: dApp.publicKey, manifestUrl: MANIFEST_LINK_2 }),
    );
    assert.deepEqual(prepared.items, [{ name: "ton_addr" }]);
  });

  await test("unknown item types are dropped, ton_addr is always present", async () => {
    const prepared = await connectManager.parseLink(
      ACCOUNT_ID,
      buildLink({
        dAppPubKey: newDApp().publicKey,
        manifestUrl: MANIFEST_LINK_2,
        items: [{ name: "ton_proof", payload: PROOF_PAYLOAD }, { name: "telegram_auth" }],
      }),
    );
    assert.deepEqual(
      prepared.items.map((item) => item.name),
      ["ton_addr", "ton_proof"],
    );
  });

  section("connect link: malformed input is a message, not a crash");

  const malformed = [
    ["a truncated r param", LINK_WITH_TRACE_ID.slice(0, 180)],
    ["no query string at all", "tc://"],
    ["missing r", "tc://?v=2&id=a5350a20b2121748cd703da51976526d2bd0fabaf96b4078eeb24f36167f3578"],
    ["missing id", "tc://?v=2&r=%7B%22manifestUrl%22%3A%22https%3A%2F%2Fapp.rignite.app%2Fx.json%22%7D"],
    ["r that is not JSON", "tc://?v=2&id=abc123&r=not-json"],
    ["an r payload that is a JSON array", `tc://?v=2&id=abc123&r=${encodeURIComponent("[1,2]")}`],
    ["no manifestUrl in the payload", `tc://?v=2&id=abc123&r=${encodeURIComponent("{}")}`],
    [
      "a non-http manifestUrl",
      `tc://?v=2&id=abc123&r=${encodeURIComponent('{"manifestUrl":"javascript:alert(1)"}')}`,
    ],
    [
      "an items value that is not an array",
      `tc://?v=2&id=abc123&r=${encodeURIComponent(
        '{"manifestUrl":"https://a.example/m.json","items":{"name":"ton_addr"}}',
      )}`,
    ],
    ["an empty link", ""],
  ];

  for (const [label, link] of malformed) {
    await test(`${label} reports "Invalid connect link"`, async () => {
      await assert.rejects(
        () => connectManager.parseLink(ACCOUNT_ID, link),
        /Invalid connect link/,
      );
    });
  }

  /* ── approve / reject ───────────────────────────────────────────────────── */

  section("connect link: approving");

  const DOMAIN_2 = "app.rignite.app";

  await test("approving a pasted link publishes a decryptable ConnectEvent", async () => {
    const dApp = newDApp();
    const link = buildLink({
      dAppPubKey: dApp.publicKey,
      manifestUrl: MANIFEST_LINK_2,
      items: [{ name: "ton_addr" }, { name: "ton_proof", payload: PROOF_PAYLOAD }],
    });

    const prepared = await nileWalletClient.parseLink(ACCOUNT_ID, link);
    published.length = 0;

    const result = await nileWalletClient.approve(ACCOUNT_ID, prepared);
    assert.equal(result.status, true);
    assert.equal(result.address, WALLET_ADDRESS);

    assert.equal(published.length, 1, "exactly one bridge publish");
    const { event, to } = openEnvelope(published[0], dApp.keyPair.secretKey);

    assert.equal(to, dApp.publicKey, "published to the requesting session");
    assert.equal(event.event, "connect");
    assert.equal(event.payload.device.appName, "NileVault");

    const names = event.payload.items.map((item) => item.name);
    assert.deepEqual(names, ["ton_addr", "ton_proof"]);

    const tonAddr = event.payload.items.find((item) => item.name === "ton_addr");
    assert.equal(Address.parseRaw(tonAddr.address).toRawString(), WALLET_ADDRESS);
    assert.equal(tonAddr.network, "-239");
    assert.ok(tonAddr.walletStateInit, "state init is attached");

    const proof = event.payload.items.find((item) => item.name === "ton_proof");
    assert.equal(proof.proof.payload, PROOF_PAYLOAD, "payload passed through verbatim");
    assert.equal(proof.proof.domain.value, DOMAIN_2);
    assert.equal(proof.proof.domain.lengthBytes, DOMAIN_2.length);
    assert.ok(
      await verifyProofSignature(proof.proof, tonAddr),
      "ton_proof signature verifies against the wallet public key",
    );

    connectManager.teardown(ACCOUNT_ID);
  });

  await test("the connection is persisted as a session", async () => {
    const dApp = newDApp();
    const link = buildLink({
      dAppPubKey: dApp.publicKey,
      manifestUrl: MANIFEST_LINK_1,
      items: [{ name: "ton_addr" }],
    });

    const prepared = await nileWalletClient.parseLink(ACCOUNT_ID, link);
    await nileWalletClient.approve(ACCOUNT_ID, prepared);

    const sessions = await nileWalletClient.sessions(ACCOUNT_ID);
    const session = sessions.sessions.find((s) => s.dAppPubKey === dApp.publicKey);
    assert.ok(session, "the dApp shows up in Connected apps");
    assert.equal(session.manifest.name, "Six Seven Club");

    connectManager.teardown(ACCOUNT_ID);
  });

  await test("a link without ton_proof returns ton_addr alone", async () => {
    const dApp = newDApp();
    const link = buildLink({
      dAppPubKey: dApp.publicKey,
      manifestUrl: MANIFEST_LINK_1,
      items: [{ name: "ton_addr" }],
    });

    const prepared = await nileWalletClient.parseLink(ACCOUNT_ID, link);
    published.length = 0;
    await nileWalletClient.approve(ACCOUNT_ID, prepared);

    const { event } = openEnvelope(published[0], dApp.keyPair.secretKey);
    assert.deepEqual(
      event.payload.items.map((item) => item.name),
      ["ton_addr"],
    );

    connectManager.teardown(ACCOUNT_ID);
  });

  await test("the real trace_id link approves and signs the requested proof", async () => {
    // Same shape as the reported link, with the session key replaced by one the
    // test can decrypt. Payload and manifest are the originals.
    const dApp = newDApp();
    const link = LINK_WITH_TRACE_ID.replace(
      "id=a5350a20b2121748cd703da51976526d2bd0fabaf96b4078eeb24f36167f3578",
      `id=${dApp.publicKey}`,
    );

    const prepared = await nileWalletClient.parseLink(ACCOUNT_ID, link);
    published.length = 0;
    const result = await nileWalletClient.approve(ACCOUNT_ID, prepared);
    assert.equal(result.address, WALLET_ADDRESS);

    const { event } = openEnvelope(published[0], dApp.keyPair.secretKey);
    const proof = event.payload.items.find((item) => item.name === "ton_proof");
    assert.equal(proof.proof.payload, PROOF_PAYLOAD);
    assert.ok(
      await verifyProofSignature(
        proof.proof,
        event.payload.items.find((item) => item.name === "ton_addr"),
      ),
    );

    connectManager.teardown(ACCOUNT_ID);
  });

  await test("regression: the old {prepared} wrapper no longer crashes approve", async () => {
    const dApp = newDApp();
    const flat = await nileWalletClient.parseLink(
      ACCOUNT_ID,
      buildLink({
        dAppPubKey: dApp.publicKey,
        manifestUrl: MANIFEST_LINK_2,
        items: [{ name: "ton_addr" }],
      }),
    );

    published.length = 0;
    await nileWalletClient.approve(ACCOUNT_ID, { status: true, prepared: flat });

    assert.equal(published.length, 1, "the nested shape still publishes");
    const { event } = openEnvelope(published[0], dApp.keyPair.secretKey);
    assert.equal(event.event, "connect");

    connectManager.teardown(ACCOUNT_ID);
  });

  await test("regression: approving a request with no session key fails readably", async () => {
    await assert.rejects(
      () => nileWalletClient.approve(ACCOUNT_ID, { status: true }),
      (error) => {
        assert.ok(
          !/reading 'length'/.test(error.message),
          `expected a readable message, got: ${error.message}`,
        );
        assert.match(error.message, /Invalid connect link/);
        return true;
      },
    );
  });

  await test("the crypto layer itself refuses an undefined session key", async () => {
    const connect = new NileWalletConnect({
      storage: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      accountId: "unit",
    });
    const keyPair = await mnemonicToPrivateKey(await mnemonicNew(24));
    connect.keyPair = keyPair;
    connect.wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });

    await assert.rejects(
      () => connect.approve({ status: true }),
      /Invalid connect link: nothing to approve/,
    );
  });

  section("connect link: rejecting");

  await test("rejecting publishes a connect_error the dApp can read", async () => {
    const dApp = newDApp();
    const link = buildLink({
      dAppPubKey: dApp.publicKey,
      manifestUrl: MANIFEST_LINK_2,
      items: [{ name: "ton_addr" }],
    });

    const prepared = await nileWalletClient.parseLink(ACCOUNT_ID, link);
    published.length = 0;
    const result = await nileWalletClient.reject(ACCOUNT_ID, prepared);
    assert.equal(result.status, true);

    const { event } = openEnvelope(published[0], dApp.keyPair.secretKey);
    assert.equal(event.event, "connect_error");
    assert.equal(event.payload.code, 300);

    const sessions = await nileWalletClient.sessions(ACCOUNT_ID);
    assert.equal(
      sessions.sessions.some((s) => s.dAppPubKey === dApp.publicKey),
      false,
      "a rejected connection leaves no session behind",
    );
  });

  await test("regression: rejecting the old {prepared} wrapper does not crash", async () => {
    const dApp = newDApp();
    const flat = await nileWalletClient.parseLink(
      ACCOUNT_ID,
      buildLink({
        dAppPubKey: dApp.publicKey,
        manifestUrl: MANIFEST_LINK_2,
        items: [{ name: "ton_addr" }],
      }),
    );

    published.length = 0;
    await nileWalletClient.reject(ACCOUNT_ID, { status: true, prepared: flat });

    const { event } = openEnvelope(published[0], dApp.keyPair.secretKey);
    assert.equal(event.event, "connect_error");
  });

  await test("a malformed link never reaches the approve path", async () => {
    await assert.rejects(
      () => nileWalletClient.parseLink(ACCOUNT_ID, LINK_TRACE_FREE.slice(0, 120)),
      /Invalid connect link/,
    );
  });

  await test("parsing needs no unlock, approving does", async () => {
    const dApp = newDApp();
    const prepared = await nileWalletClient.parseLink(
      ACCOUNT_ID,
      buildLink({
        dAppPubKey: dApp.publicKey,
        manifestUrl: MANIFEST_LINK_2,
        items: [{ name: "ton_addr" }],
      }),
    );

    // A cold instance, as a locked app would have after a restart.
    connectManager.teardown(ACCOUNT_ID);
    await nileWallet.lock();

    const whileLocked = await nileWalletClient.parseLink(ACCOUNT_ID, LINK_TRACE_FREE);
    assert.equal(whileLocked.manifest.name, "Six Seven Club");

    await assert.rejects(
      () => nileWalletClient.approve(ACCOUNT_ID, prepared),
      (error) => error instanceof NileWalletLockedError,
    );

    await nileWallet.unlock(VAULT_PASS);
  });

  connectManager.teardownAll();

  /* ── summary ─────────────────────────────────────────────────────────────── */

  console.log("\nresults");

  if (failures.length) {
    console.log(`\n${passed} passed, ${failures.length} failed\n`);
    for (const { name, error } of failures) {
      console.log(`  FAILED: ${name}\n  ${error.stack}\n`);
    }
    process.exit(1);
  }

  console.log(`\n${passed} passed, 0 failed\n`);
}

main().catch((error) => {
  console.error("\nharness crashed:\n", error);
  process.exit(1);
});
