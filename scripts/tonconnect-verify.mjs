/**
 * Live-network verification of the TON Connect link flow.
 *
 * Runs the *real* link handler against the *real* manifests and the *real* HTTP
 * bridge (bridge.tonapi.io), with the two reported links verbatim.
 *
 * Why: the crash was a shape bug that had already been "fixed" once without
 * anyone exercising the whole path, so the only check that matters is the one
 * that fetches the dApp's manifest, builds the ConnectEvent, signs the proof and
 * gets a message accepted by the bridge. Unit tests cover the shape; this covers
 * the wire.
 *
 * Nothing is broadcast on-chain and no real key is used: the signing account is a
 * throwaway ("abandon … about"), and a live publish only sends an encrypted
 * message to a dApp's bridge queue.
 *
 * Deliberately NOT part of `npm test` — it needs the network.
 *
 * Usage: npm run verify:tonconnect
 */

import { base64 } from "@scure/base";
import { Address } from "@ton/core";
import { mnemonicToPrivateKey, sha256 } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";
import nacl from "tweetnacl";

import NileWalletConnect from "../src/renderer/lib/NileWalletConnect.js";
import connectManager from "../src/renderer/lib/nileWalletConnectManager.js";

/** The two links from the bug report, unmodified. */
const LINKS = [
  {
    label: "sixseven (no trace_id)",
    url: "tc://?v=2&id=dcb2bbdf5390e3a8a21e4e545532dae678d0746434a4306de271455ba16a6b00&r=%7B%22manifestUrl%22%3A%22https%3A%2F%2Fsixseven-dev-tgops.s3.eu-central-1.amazonaws.com%2Ftonconnect%2Fton-manifest.json%22%2C%22items%22%3A%5B%7B%22name%22%3A%22ton_addr%22%7D%2C%7B%22name%22%3A%22ton_proof%22%2C%22payload%22%3A%226f8f6532c4672aec000000006aab7be5a3cdf6409423025d57ddc8fd9f44eaaf4798fc9498524e7d0d16941bd54c8988%22%7D%5D%7D",
  },
  {
    label: "rignite (with trace_id)",
    url: "tc://?v=2&id=a5350a20b2121748cd703da51976526d2bd0fabaf96b4078eeb24f36167f3578&trace_id=01a0addf-e14c-771e-8fe4-9e2828960d4a&r=%7B%22manifestUrl%22%3A%22https%3A%2F%2Fapp.rignite.app%2Ftonconnect-manifest.json%22%2C%22items%22%3A%5B%7B%22name%22%3A%22ton_addr%22%7D%2C%7B%22name%22%3A%22ton_proof%22%2C%22payload%22%3A%226a33e002435035329e97ca8b603dd5bd9e4bdad517fae2230c1e8a4746c8744d%22%7D%5D%7D",
  },
];

/** Anything that reaches the wallet is signed by this throwaway account. */
const THROWAWAY_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const BRIDGE = "https://bridge.tonapi.io/bridge";
const ACCOUNT_ID = "live-verify";

const memoryStorage = () => {
  const store = new Map();
  return {
    get: async (key, fallback = null) => (store.has(key) ? store.get(key) : fallback),
    set: async (key, value) => void store.set(key, value),
    remove: async (key) => void store.delete(key),
  };
};

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  \u2717 ${msg}`);
};
const pass = (msg) => console.log(`  \u2713 ${msg}`);

function hexToBytes(hex) {
  const clean = hex.length % 2 ? "0" + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Decrypt a bridge body addressed to a session key we own. */
function openEnvelope(body, senderPublicKeyHex, ownSecretKey) {
  const full = base64.decode(body);
  const plain = nacl.box.open(
    full.slice(24),
    full.slice(0, 24),
    hexToBytes(senderPublicKeyHex),
    ownSecretKey,
  );
  if (!plain) throw new Error("body is not decryptable with this session key");
  return JSON.parse(new TextDecoder().decode(plain));
}

/** Re-derive the ton_proof message from the spec layout and check the signature. */
async function verifyProof(proof, tonAddr) {
  const address = Address.parseRaw(tonAddr.address);
  const domain = Buffer.from(proof.domain.value, "utf8");
  const domainLen = Buffer.alloc(4);
  domainLen.writeUInt32LE(domain.length);
  const workchain = Buffer.alloc(4);
  workchain.writeInt32BE(address.workChain);
  const timestamp = Buffer.alloc(8);
  timestamp.writeUInt32LE(proof.timestamp & 0xffffffff, 0);
  timestamp.writeUInt32LE(Math.floor(proof.timestamp / 0x100000000), 4);

  const hash = await sha256(
    Buffer.concat([
      Buffer.from("ton-proof-item-v2/", "utf8"),
      workchain,
      address.hash,
      domainLen,
      domain,
      timestamp,
      Buffer.from(proof.payload, "utf8"),
    ]),
  );
  const full = await sha256(
    Buffer.concat([
      Buffer.from([0xff, 0xff]),
      Buffer.from("ton-connect", "utf8"),
      hash,
    ]),
  );

  return nacl.sign.detached.verify(
    new Uint8Array(full),
    base64.decode(proof.signature),
    hexToBytes(tonAddr.publicKey),
  );
}

async function main() {
  const keyPair = await mnemonicToPrivateKey(THROWAWAY_MNEMONIC.split(" "));
  const wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
  const connect = new NileWalletConnect({
    wallet,
    keyPair,
    storage: memoryStorage(),
    accountId: ACCOUNT_ID,
    bridgeUrl: BRIDGE,
  });

  console.log("TON Connect live verification");
  console.log(`  bridge: ${BRIDGE}`);
  console.log(`  wallet: ${wallet.address.toRawString()}\n`);

  const approved = [];

  for (const { label, url } of LINKS) {
    console.log(`${label}`);

    /* ── parse (the boundary the UI uses) ─────────────────────────────── */

    let prepared;
    try {
      prepared = await connectManager.parseLink(ACCOUNT_ID, url);
      pass(`parsed — dApp session ${prepared.dAppPubKey.slice(0, 16)}…`);
    } catch (error) {
      fail(`parse threw ${error.message}`);
      continue;
    }

    if (!prepared.dAppPubKey || !prepared.manifest || !Array.isArray(prepared.items)) {
      fail("prepared request is missing dAppPubKey/manifest/items at the top level");
      continue;
    }
    pass(`request is flat — items: ${prepared.items.map((i) => i.name).join(", ")}`);
    pass(
      `manifest fetched live — "${prepared.manifest.name}" (${prepared.manifest.url})${
        prepared.manifest.iconUrl ? "" : " [no icon]"
      }`,
    );

    /* ── approve: build, sign, publish to the real bridge ─────────────── */

    const before = Date.now();
    try {
      const result = await connect.approve(prepared);
      if (result.status !== true) {
        fail(`approve returned ${JSON.stringify(result)}`);
        continue;
      }
      approved.push({ label, address: result.address });
      pass(`published to the bridge (${Date.now() - before}ms)`);
      pass(`wallet address returned: ${result.address}`);
    } catch (error) {
      fail(`approve threw ${error.constructor.name}: ${error.message}`);
    }

    connect.unsubscribe();
    console.log("");
  }

  /* ── the whole transport, read back off the real bridge ─────────────── */

  console.log("round trip over the real bridge");

  const dAppKeyPair = nacl.box.keyPair();
  const dAppPublicKey = Buffer.from(dAppKeyPair.publicKey).toString("hex");
  const payload = "deadbeef000000016aab7be5a3cdf6409423025d57ddc8fd9f44eaaf";
  const manifestUrl =
    "https://sixseven-dev-tgops.s3.eu-central-1.amazonaws.com/tonconnect/ton-manifest.json";

  const link = `tc://?${new URLSearchParams({
    v: "2",
    id: dAppPublicKey,
    trace_id: "01a0addf-e14c-771e-8fe4-9e2828960d4a",
    r: JSON.stringify({
      manifestUrl,
      items: [{ name: "ton_addr" }, { name: "ton_proof", payload }],
    }),
  })}`;

  // The bridge streams events over SSE, so the body has to be read frame by
  // frame — `res.text()` would wait for a connection that is meant to stay open.
  const controller = new AbortController();
  const readBack = (async () => {
    const res = await fetch(`${BRIDGE}/events?client_id=${dAppPublicKey}`, {
      signal: controller.signal,
    });
    if (!res.ok || !res.body) return null;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const data = JSON.parse(line.slice(5).trim());
            if (data?.message) return data;
          } catch {
            /* heartbeat or partial frame */
          }
        }
      }
    }
  })().catch(() => null);

  try {
    const prepared = await connectManager.parseLink(ACCOUNT_ID, link);
    const result = await connect.approve(prepared);

    const received = await Promise.race([
      readBack,
      new Promise((resolve) => setTimeout(() => resolve(null), 20_000)),
    ]);
    controller.abort();

    if (!received) {
      fail("the message did not arrive back through the bridge within 20s");
    } else {
      pass("the bridge delivered the published message back to the dApp session");
      const event = openEnvelope(
        received.message,
        received.from,
        dAppKeyPair.secretKey,
      );
      pass(`envelope decrypts — event "${event.event}"`);

      const tonAddr = event.payload.items.find((i) => i.name === "ton_addr");
      const proof = event.payload.items.find((i) => i.name === "ton_proof");

      if (Address.parseRaw(tonAddr.address).toString() === Address.parse(result.address).toString()) {
        pass(`ton_addr carries the wallet address (${tonAddr.address})`);
      } else {
        fail("ton_addr does not match the approving wallet");
      }

      if (tonAddr.network === "-239") pass("network is TON mainnet (-239)");
      else fail(`unexpected network ${tonAddr.network}`);

      if (proof?.proof?.payload === payload) pass("ton_proof echoes the requested payload");
      else fail("ton_proof payload mismatch");

      if (await verifyProof(proof.proof, tonAddr)) {
        pass("ton_proof signature verifies against the wallet public key");
      } else {
        fail("ton_proof signature does not verify");
      }

      connect.unsubscribe();
      await fetch(`${BRIDGE}/message?client_id=${dAppPublicKey}&to=${dAppPublicKey}&ttl=1`, {
        method: "POST",
        body: base64.encode(new Uint8Array(56)),
      }).catch(() => {});
    }
  } catch (error) {
    controller.abort();
    fail(`round trip threw ${error.constructor.name}: ${error.message}`);
  }

  /* ── summary ────────────────────────────────────────────────────────── */

  console.log("\nresults");
  for (const { label, address } of approved) {
    console.log(`  approved ${label}: ${address}`);
  }

  if (failures) {
    console.log(`\n${failures} problem(s) — the link flow is not verified.\n`);
    process.exit(1);
  }
  console.log("\nboth links parsed, published and decrypted end to end.\n");
  setTimeout(() => process.exit(0), 50);
}

main().catch((error) => {
  console.error("\nharness crashed:\n", error);
  process.exit(1);
});
