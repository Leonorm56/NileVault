import { base64 } from "@scure/base";
import { sha256, sign } from "@ton/crypto";
import { beginCell, storeStateInit } from "@ton/ton";
import { Buffer } from "buffer";
import nacl from "tweetnacl";

/** Default TON Connect HTTP bridge (the bridge NileWallet advertises). */
const DEFAULT_BRIDGE = "https://bridge.tonapi.io/bridge";
const FALLBACK_BRIDGES = [
  "https://bridge.tonapi.io/bridge",
  "https://bridgeconnect.ton.org/bridge",
];
const WALLET_APP_NAME = "NileChain";
const WALLET_VERSION = "1.0.0";
/** TON mainnet CHAIN id used in ton_addr items. */
const TON_MAINNET = "-239";
const NONCE_LENGTH = nacl.box.nonceLength; // 24

/** hex string -> Uint8Array */
function hexToBytes(hex) {
  const clean = hex.length % 2 ? "0" + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Uint8Array -> hex string */
function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * NileWalletConnect
 *
 * Wallet-side TON Connect v2 client for the HTTP-bridge (universal `tc://`
 * link) flow. Each dApp connection is a session keyed by the dApp's session
 * public key; the wallet generates its own x25519 session keypair, and every
 * bridge payload is NaCl-box encrypted (x25519 + xsalsa20-poly1305) between the
 * two session keys — matching what real dApps expect.
 *
 * The injected `window.tonconnect` JS-bridge path does NOT use this transport;
 * it reuses {@link buildConnectItems}/{@link buildConnectEvent} directly.
 *
 * Runs only in the MV3 service worker. No DOM, no page crypto.
 */
export default class NileWalletConnect {
  /**
   * @param {object} params
   * @param {object} params.wallet @ton/ton WalletContractV4
   * @param {import("@ton/crypto").KeyPair} params.keyPair account signing keypair (ed25519)
   * @param {object} params.storage StorageAdapter-shaped { get, set, remove }
   * @param {string} params.accountId
   * @param {(request: object) => void} [params.onRequest] fires on inbound bridge requests
   * @param {string} [params.bridgeUrl]
   */
  constructor({ wallet, keyPair, storage, accountId, onRequest, bridgeUrl }) {
    this.wallet = wallet;
    this.keyPair = keyPair;
    this.storage = storage;
    this.accountId = accountId;
    this.onRequest = onRequest || (() => {});
    this.bridgeUrl = bridgeUrl || DEFAULT_BRIDGE;
    this.sessionsKey = `account-${accountId}:nile-wallet:sessions`;
    this.source = null;
    this.eventId = Date.now();
  }

  /* ------------------------------------------------------------------ */
  /* Session persistence                                                 */
  /* ------------------------------------------------------------------ */

  /** Load the persisted session map keyed by dApp session public key. */
  async loadSessions() {
    return (await this.storage.get(this.sessionsKey, {})) || {};
  }

  /** Persist a single session. */
  async saveSession(dAppPubKey, session) {
    const sessions = await this.loadSessions();
    sessions[dAppPubKey] = session;
    await this.storage.set(this.sessionsKey, sessions);
  }

  /** Remove a single session. */
  async removeSession(dAppPubKey) {
    const sessions = await this.loadSessions();
    delete sessions[dAppPubKey];
    await this.storage.set(this.sessionsKey, sessions);
  }

  /* ------------------------------------------------------------------ */
  /* Universal-link parsing                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Parse a `tc://` or `https://…/ton-connect` universal link.
   * @param {string} link
   * @returns {{ version: string, dAppPubKey: string, request: object, ret: string|null }}
   */
  parseLink(link) {
    const queryIndex = link.indexOf("?");
    if (queryIndex === -1) throw new Error("Invalid TON Connect link");

    const params = new URLSearchParams(link.slice(queryIndex + 1));
    const dAppPubKey = params.get("id");
    const rParam = params.get("r");

    if (!dAppPubKey || !rParam) {
      throw new Error("TON Connect link missing id/r");
    }

    let request;
    try {
      request = JSON.parse(rParam);
    } catch (e) {
      request = JSON.parse(decodeURIComponent(rParam));
    }

    return {
      version: params.get("v") || "2",
      dAppPubKey,
      request,
      ret: params.get("ret"),
    };
  }

  /**
   * Turn a raw link into a UI-ready connect request (fetches the manifest so
   * the modal can show the requesting app's name/icon), and stash it pending.
   */
  async prepareConnectRequest(link) {
    const { dAppPubKey, request, ret } = this.parseLink(link);
    const manifest = await this.fetchManifest(request.manifestUrl);

    return {
      transport: "bridge",
      dAppPubKey,
      ret,
      manifestUrl: request.manifestUrl,
      manifest,
      items: request.items || [{ name: "ton_addr" }],
    };
  }

  /** Fetch and normalize a TON Connect manifest (best-effort). */
  async fetchManifest(manifestUrl) {
    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`manifest ${res.status}`);
      const data = await res.json();
      return {
        url: data.url || manifestUrl,
        name: data.name || new URL(manifestUrl).host,
        iconUrl: data.iconUrl || null,
      };
    } catch (e) {
      const host = (() => {
        try {
          return new URL(manifestUrl).host;
        } catch {
          return manifestUrl;
        }
      })();
      return { url: manifestUrl, name: host, iconUrl: null };
    }
  }

  /* ------------------------------------------------------------------ */
  /* Bridge crypto (NaCl box)                                            */
  /* ------------------------------------------------------------------ */

  /** Encrypt an object for a receiver session public key. */
  boxEncrypt(obj, receiverPubKeyHex, walletSecretKeyBytes) {
    const nonce = nacl.randomBytes(NONCE_LENGTH);
    const msg = new TextEncoder().encode(JSON.stringify(obj));
    const cipher = nacl.box(
      msg,
      nonce,
      hexToBytes(receiverPubKeyHex),
      walletSecretKeyBytes,
    );
    const full = new Uint8Array(nonce.length + cipher.length);
    full.set(nonce);
    full.set(cipher, nonce.length);
    return base64.encode(full);
  }

  /** Decrypt a base64 bridge body from a sender session public key. */
  boxDecrypt(b64, senderPubKeyHex, walletSecretKeyBytes) {
    const full = base64.decode(b64);
    const nonce = full.slice(0, NONCE_LENGTH);
    const cipher = full.slice(NONCE_LENGTH);
    const msg = nacl.box.open(
      cipher,
      nonce,
      hexToBytes(senderPubKeyHex),
      walletSecretKeyBytes,
    );
    if (!msg) throw new Error("Bridge message decryption failed");
    return JSON.parse(new TextDecoder().decode(msg));
  }

  /** POST an already-encrypted body to the bridge. */
  async sendToBridge(senderPubKeyHex, receiverPubKeyHex, b64body, topic) {
    const url =
      `${this.bridgeUrl}/message?client_id=${senderPubKeyHex}` +
      `&to=${receiverPubKeyHex}&ttl=300` +
      (topic ? `&topic=${topic}` : "");

    const res = await fetch(url, { method: "POST", body: b64body });
    if (!res.ok) throw new Error(`Bridge publish failed ${res.status}`);
  }

  /* ------------------------------------------------------------------ */
  /* ton_addr / ton_proof                                                */
  /* ------------------------------------------------------------------ */

  /** Wallet state-init as base64 BOC (for the ton_addr item). */
  getStateInit() {
    return beginCell()
      .store(storeStateInit(this.wallet.init))
      .endCell()
      .toBoc()
      .toString("base64");
  }

  /** Build the ton_addr item. */
  buildAddressItem() {
    return {
      name: "ton_addr",
      address: this.wallet.address.toRawString(),
      network: TON_MAINNET,
      publicKey: this.keyPair.publicKey.toString("hex"),
      walletStateInit: this.getStateInit(),
    };
  }

  /** Build the signed ton_proof item for a given domain + payload. */
  async buildProofItem(payload, domain) {
    const address = this.wallet.address;
    const timestamp = Math.floor(Date.now() / 1000);

    const domainBuffer = Buffer.from(domain, "utf8");
    const domainLenBuffer = Buffer.alloc(4);
    domainLenBuffer.writeUInt32LE(domainBuffer.length);

    const workchainBuffer = Buffer.alloc(4);
    workchainBuffer.writeInt32BE(address.workChain);

    const timestampBuffer = Buffer.alloc(8);
    timestampBuffer.writeUInt32LE(timestamp & 0xffffffff, 0);
    timestampBuffer.writeUInt32LE(Math.floor(timestamp / 0x100000000), 4);

    const payloadBuffer = Buffer.from(payload, "utf8");

    const message = Buffer.concat([
      Buffer.from("ton-proof-item-v2/", "utf8"),
      workchainBuffer,
      address.hash,
      domainLenBuffer,
      domainBuffer,
      timestampBuffer,
      payloadBuffer,
    ]);

    const messageHash = await sha256(message);
    const fullMessage = Buffer.concat([
      Buffer.from([0xff, 0xff]),
      Buffer.from("ton-connect", "utf8"),
      messageHash,
    ]);
    const fullMessageHash = await sha256(fullMessage);
    const signature = sign(fullMessageHash, this.keyPair.secretKey);

    return {
      name: "ton_proof",
      proof: {
        timestamp,
        domain: {
          lengthBytes: domainBuffer.length,
          value: domain,
        },
        payload,
        signature: signature.toString("base64"),
      },
    };
  }

  /**
   * Build the connect reply items for a request's `items`.
   * Shared by the bridge flow and the injected JS-bridge flow.
   * @param {Array<{name:string, payload?:string}>} requestedItems
   * @param {string} domain manifest host, for ton_proof
   */
  async buildConnectItems(requestedItems, domain) {
    const items = [];
    for (const item of requestedItems || [{ name: "ton_addr" }]) {
      if (item.name === "ton_addr") {
        items.push(this.buildAddressItem());
      } else if (item.name === "ton_proof") {
        items.push(await this.buildProofItem(item.payload || "", domain));
      }
    }
    if (!items.length) items.push(this.buildAddressItem());
    return items;
  }

  /** The device descriptor advertised in the ConnectEvent. */
  getDeviceInfo() {
    return {
      platform: "android",
      appName: WALLET_APP_NAME,
      appVersion: WALLET_VERSION,
      maxProtocolVersion: 2,
      features: [
        "SendTransaction",
        { name: "SendTransaction", maxMessages: 4 },
      ],
    };
  }

  /** Build a full ConnectEvent payload (items + device). */
  async buildConnectEvent(requestedItems, domain) {
    return {
      event: "connect",
      id: this.eventId++,
      payload: {
        items: await this.buildConnectItems(requestedItems, domain),
        device: this.getDeviceInfo(),
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Approve / reject / restore (bridge flow)                            */
  /* ------------------------------------------------------------------ */

  /**
   * Approve a prepared connect request: sign, encrypt, publish to the bridge,
   * persist the session and start listening for follow-up requests.
   * @param {object} prepared output of {@link prepareConnectRequest}
   */
  async approve(prepared) {
    const { dAppPubKey, manifest, manifestUrl, items } = prepared;
    const domain = (() => {
      try {
        return new URL(manifest?.url || manifestUrl).host;
      } catch {
        return manifest?.name || "";
      }
    })();

    /** Wallet session keypair (x25519) — one per dApp session. */
    const walletKeyPair = nacl.box.keyPair();
    const walletPublicKey = bytesToHex(walletKeyPair.publicKey);
    const walletSecretKey = bytesToHex(walletKeyPair.secretKey);

    const event = await this.buildConnectEvent(items, domain);
    const body = this.boxEncrypt(event, dAppPubKey, walletKeyPair.secretKey);

    await this.sendToBridge(walletPublicKey, dAppPubKey, body);

    await this.saveSession(dAppPubKey, {
      dAppPubKey,
      walletPublicKey,
      walletSecretKey,
      manifest,
      manifestUrl,
      bridgeUrl: this.bridgeUrl,
      lastEventId: null,
      connectedAt: Date.now(),
    });

    await this.subscribe();
    return { status: true, address: this.wallet.address.toRawString() };
  }

  /**
   * Reject a prepared connect request. A session that was never established
   * has no wallet keypair yet, so we mint an ephemeral one just to deliver the
   * encrypted error to the dApp.
   */
  async reject(prepared) {
    const { dAppPubKey } = prepared;
    const walletKeyPair = nacl.box.keyPair();
    const walletPublicKey = bytesToHex(walletKeyPair.publicKey);

    const event = {
      event: "connect_error",
      id: this.eventId++,
      payload: { code: 300, message: "User rejected the connection" },
    };
    const body = this.boxEncrypt(event, dAppPubKey, walletKeyPair.secretKey);
    await this.sendToBridge(walletPublicKey, dAppPubKey, body);
    return { status: true };
  }

  /** Disconnect an active session and tell the dApp. */
  async disconnect(dAppPubKey) {
    const sessions = await this.loadSessions();
    const session = sessions[dAppPubKey];
    if (session) {
      const event = { event: "disconnect", id: this.eventId++, payload: {} };
      const body = this.boxEncrypt(
        event,
        dAppPubKey,
        hexToBytes(session.walletSecretKey),
      );
      try {
        await this.sendToBridge(session.walletPublicKey, dAppPubKey, body);
      } catch (e) {
        /* best-effort */
      }
      await this.removeSession(dAppPubKey);
    }
    await this.subscribe();
    return { status: true };
  }

  /* ------------------------------------------------------------------ */
  /* Bridge subscription (receive follow-up requests)                    */
  /* ------------------------------------------------------------------ */

  /**
   * (Re)subscribe to the bridge for every persisted session so follow-up
   * requests (sendTransaction, disconnect) arrive. Called on approve and on
   * service-worker startup (restore). Tries multiple bridges and falls back
   * to HTTP polling if EventSource is blocked by a proxy.
   */
  async subscribe() {
    const sessions = await this.loadSessions();
    const clientIds = Object.values(sessions).map((s) => s.walletPublicKey);

    if (this.source) {
      this.source.close();
      this.source = null;
    }
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    if (!clientIds.length) return null;

    const bridges = [
      this.bridgeUrl,
      ...FALLBACK_BRIDGES.filter((b) => b !== this.bridgeUrl),
    ];

    for (const bridge of bridges) {
      try {
        const ok = await this._trySubscribeSSE(bridge, clientIds);
        if (ok) return clientIds;
      } catch { /* try next bridge */ }
    }

    this._startPolling(bridges, clientIds);
    return clientIds;
  }

  _trySubscribeSSE(bridge, clientIds) {
    return new Promise((resolve, reject) => {
      const url = `${bridge}/events?client_id=${clientIds.join(",")}`;
      const source = new EventSource(url);
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          source.close();
          reject(new Error("bridge connect timeout"));
        }
      }, 5000);

      source.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (this.source) this.source.close();
        this.source = source;
        this._activeBridge = bridge;

        source.onmessage = (ev) => {
          this.handleBridgeMessage(ev).catch((e) =>
            console.error("NileWallet bridge message error:", e),
          );
        };
        source.onerror = (e) => {
          console.error("NileWallet bridge SSE error:", e);
          source.close();
          this.source = null;
          setTimeout(() => this.subscribe().catch(() => {}), 3000);
        };

        resolve(true);
      };

      source.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          source.close();
          reject(new Error("SSE connection failed"));
        }
      };
    });
  }

  _startPolling(bridges, clientIds) {
    const poll = async () => {
      for (const bridge of bridges) {
        try {
          const since = this._lastEventId || "";
          const url = `${bridge}/events?client_id=${clientIds.join(",")}${since ? `&last_event_id=${since}` : ""}`;
          const res = await fetch(url);
          if (!res.ok) continue;
          const text = await res.text();
          if (!text.trim()) continue;

          const lines = text.split("\n\n").filter(Boolean);
          for (const block of lines) {
            const ev = { data: "", lastEventId: "" };
            for (const line of block.split("\n")) {
              if (line.startsWith("data:")) ev.data = line.slice(5).trim();
              if (line.startsWith("id:")) ev.lastEventId = line.slice(3).trim();
            }
            if (ev.data) await this.handleBridgeMessage(ev);
          }
          this._activeBridge = bridge;
          break;
        } catch { /* try next bridge */ }
      }
      this._pollTimer = setTimeout(poll, 2000);
    };
    poll();
  }

  /** Handle one inbound (encrypted) SSE bridge message. */
  async handleBridgeMessage(ev) {
    const data = JSON.parse(ev.data);
    const from = data.from;
    const sessions = await this.loadSessions();
    const session = sessions[from];
    if (!session) return; // message from an unknown dApp session

    const request = this.boxDecrypt(
      data.message,
      from,
      hexToBytes(session.walletSecretKey),
    );

    // Persist the bridge cursor so restore doesn't replay old events.
    if (ev.lastEventId) {
      session.lastEventId = ev.lastEventId;
      await this.saveSession(from, session);
    }

    if (request.method === "disconnect") {
      await this.removeSession(from);
      await this.subscribe();
      return;
    }

    // Forward everything else (e.g. sendTransaction) to the UI/SW layer.
    this.onRequest({
      transport: "bridge",
      dAppPubKey: from,
      manifest: session.manifest,
      request,
    });
  }

  /** Close the bridge connection. */
  unsubscribe() {
    if (this.source) {
      this.source.close();
      this.source = null;
    }
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }
}
