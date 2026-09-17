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
/**
 * Identity advertised to dApps. This must be the app the user actually has
 * open — it previously said "NileChain", so a dApp's UI named the wrong wallet.
 */
const WALLET_APP_NAME = "NileVault";
const WALLET_VERSION = "1.0.0";
/** TON mainnet CHAIN id used in ton_addr items. */
const TON_MAINNET = "-239";
const NONCE_LENGTH = nacl.box.nonceLength; // 24

/**
 * hex string -> Uint8Array.
 *
 * Validates its input. An absent key used to reach `hex.length` and surface as
 * "Cannot read properties of undefined (reading 'length')" from inside the box
 * encryption — a stack trace with no hint of the real problem. Every caller now
 * gets a message that can be shown to the user instead.
 */
function hexToBytes(hex) {
  if (typeof hex !== "string" || !hex.trim()) {
    throw new Error("Connect session key is missing");
  }
  const trimmed = hex.trim();
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
    throw new Error("Connect session key is malformed");
  }
  const clean = trimmed.length % 2 ? "0" + trimmed : trimmed;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Item names a wallet may answer. Anything else is ignored. */
const SUPPORTED_ITEMS = ["ton_addr", "ton_proof"];

/**
 * Normalize a request's `items` list.
 *
 * `items` is not a fixed, always-present part of a connect link: a dApp may ask
 * for `ton_addr` alone, may omit the list, and may add item types this wallet
 * does not implement. So the list is validated rather than trusted — a non-array
 * becomes the default, unknown names are dropped, and a `ton_proof` item always
 * carries a string payload (the proof builder must never see `undefined`).
 *
 * `ton_addr` is always present in the result: the spec makes it mandatory in a
 * ConnectEvent reply, so a request that only asks for `ton_proof` still gets an
 * address.
 */
function normalizeRequestItems(items) {
  const list = Array.isArray(items) ? items : [];
  const normalized = [];

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    if (!SUPPORTED_ITEMS.includes(item.name)) continue;
    if (normalized.some((entry) => entry.name === item.name)) continue;
    normalized.push(
      item.name === "ton_proof"
        ? {
            name: "ton_proof",
            payload: typeof item.payload === "string" ? item.payload : "",
          }
        : { name: "ton_addr" },
    );
  }

  if (!normalized.some((entry) => entry.name === "ton_addr")) {
    normalized.unshift({ name: "ton_addr" });
  }
  return normalized;
}

/**
 * Validate a prepared connect request before it is signed/published.
 *
 * The request round-trips through the UI (manager → modal → manager), so the
 * fields this flow depends on are checked here rather than assumed: without it
 * a missing `dAppPubKey` produced a TypeError inside the box encryption.
 */
function assertPrepared(prepared) {
  // Tolerate the historical `{ status, prepared }` envelope: a request that
  // round-tripped through an older UI must still approve rather than arriving
  // here with every field undefined.
  const request =
    prepared && typeof prepared === "object" && prepared.prepared && !prepared.dAppPubKey
      ? prepared.prepared
      : prepared;

  if (!request || typeof request !== "object" || !request.dAppPubKey) {
    throw new Error("Invalid connect link: nothing to approve");
  }
  return {
    dAppPubKey: String(request.dAppPubKey).trim(),
    manifest: request.manifest || {},
    manifestUrl: request.manifestUrl || request.manifest?.url || null,
    items: normalizeRequestItems(request.items),
  };
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
 * Runs in the renderer. NileChain's version ran in an MV3 service worker because
 * its popup was ephemeral; NileVault's BrowserWindow is persistent, so the
 * EventSource bridge lives here alongside the rest of the wallet stack.
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
   *
   * Params are read by name, never by position, so a link is free to carry extra
   * ones — `rignite` sends `trace_id` where `sixseven` sends nothing, and both
   * are handled identically here. A link that cannot be understood fails with a
   * single user-facing "Invalid connect link" message rather than a TypeError
   * from somewhere deeper in the crypto path.
   *
   * @param {string} link
   * @returns {{ version: string, dAppPubKey: string, request: object, ret: string|null, traceId: string|null }}
   */
  parseLink(link) {
    if (typeof link !== "string" || !link.trim()) {
      throw new Error("Invalid connect link");
    }

    const trimmed = link.trim();
    const queryIndex = trimmed.indexOf("?");
    if (queryIndex === -1) throw new Error("Invalid connect link");

    const params = new URLSearchParams(trimmed.slice(queryIndex + 1));
    const dAppPubKey = (params.get("id") || "").trim();
    const rParam = params.get("r");

    if (!dAppPubKey || !rParam) {
      throw new Error("Invalid connect link: missing id or r parameter");
    }
    if (!/^[0-9a-fA-F]+$/.test(dAppPubKey)) {
      throw new Error("Invalid connect link: malformed session id");
    }

    return {
      version: params.get("v") || "2",
      dAppPubKey,
      request: this.decodeRequestPayload(rParam),
      ret: params.get("ret"),
      traceId: params.get("trace_id"),
    };
  }

  /**
   * Decode the `r` query parameter into a connect request object.
   *
   * `r` is URL-encoded JSON, but dApps vary: some send it encoded twice, some
   * send it raw. Both forms are tried, and every failure mode collapses into the
   * same clear error so the UI can say "Invalid connect link" instead of leaking
   * a JSON.parse message.
   */
  decodeRequestPayload(rParam) {
    const candidates = [rParam];
    try {
      const onceMore = decodeURIComponent(rParam);
      if (onceMore !== rParam) candidates.push(onceMore);
    } catch {
      /* not percent-encoded — the raw value is already covered */
    }

    let parsed = null;
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      try {
        const value = JSON.parse(candidate);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          parsed = value;
          break;
        }
      } catch {
        /* try the next decoding */
      }
    }

    if (!parsed) {
      throw new Error("Invalid connect link: could not read the request payload");
    }
    if (
      typeof parsed.manifestUrl !== "string" ||
      !/^https?:\/\//i.test(parsed.manifestUrl.trim())
    ) {
      throw new Error("Invalid connect link: missing app manifest URL");
    }
    if (parsed.items !== undefined && !Array.isArray(parsed.items)) {
      throw new Error("Invalid connect link: malformed items list");
    }

    return { ...parsed, manifestUrl: parsed.manifestUrl.trim() };
  }

  /**
   * Turn a raw link into a UI-ready connect request (fetches the manifest so
   * the modal can show the requesting app's name/icon).
   */
  async prepareConnectRequest(link) {
    const { dAppPubKey, request, ret, traceId } = this.parseLink(link);
    const manifest = await this.fetchManifest(request.manifestUrl);

    return {
      transport: "bridge",
      dAppPubKey,
      ret,
      traceId,
      manifestUrl: request.manifestUrl,
      manifest,
      items: normalizeRequestItems(request.items),
    };
  }

  /**
   * Fetch and normalize a TON Connect manifest (best-effort).
   *
   * The response shape is never assumed: a manifest that is empty, is not an
   * object, or renames a field still yields a usable identity (host name, no
   * icon) so the approval sheet renders instead of failing.
   */
  async fetchManifest(manifestUrl) {
    const fallbackName = (() => {
      try {
        return new URL(manifestUrl).host;
      } catch {
        return typeof manifestUrl === "string" ? manifestUrl : "";
      }
    })();

    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`manifest ${res.status}`);
      const data = await res.json();
      const manifest = data && typeof data === "object" ? data : {};
      return {
        url:
          typeof manifest.url === "string" && manifest.url
            ? manifest.url
            : manifestUrl,
        name:
          typeof manifest.name === "string" && manifest.name
            ? manifest.name
            : fallbackName,
        iconUrl:
          typeof manifest.iconUrl === "string" && manifest.iconUrl
            ? manifest.iconUrl
            : null,
      };
    } catch (e) {
      return { url: manifestUrl, name: fallbackName, iconUrl: null };
    }
  }

  /* ------------------------------------------------------------------ */
  /* Bridge crypto (NaCl box)                                            */
  /* ------------------------------------------------------------------ */

  /** Encrypt an object for a receiver session public key. */
  boxEncrypt(obj, receiverPubKeyHex, walletSecretKeyBytes) {
    // Resolved before the nonce is drawn so a bad key throws (with a readable
    // message) rather than producing an undecryptable body.
    const receiverPublicKey = hexToBytes(receiverPubKeyHex);
    if (
      !walletSecretKeyBytes ||
      walletSecretKeyBytes.length !== nacl.box.secretKeyLength
    ) {
      throw new Error("Connect session key is unavailable — reconnect the app");
    }
    const nonce = nacl.randomBytes(NONCE_LENGTH);
    const msg = new TextEncoder().encode(JSON.stringify(obj));
    const cipher = nacl.box(msg, nonce, receiverPublicKey, walletSecretKeyBytes);
    const full = new Uint8Array(nonce.length + cipher.length);
    full.set(nonce);
    full.set(cipher, nonce.length);
    return base64.encode(full);
  }

  /** Decrypt a base64 bridge body from a sender session public key. */
  boxDecrypt(b64, senderPubKeyHex, walletSecretKeyBytes) {
    const senderPublicKey = hexToBytes(senderPubKeyHex);
    if (
      !walletSecretKeyBytes ||
      walletSecretKeyBytes.length !== nacl.box.secretKeyLength
    ) {
      throw new Error("Connect session key is unavailable — reconnect the app");
    }
    const full = base64.decode(b64);
    const nonce = full.slice(0, NONCE_LENGTH);
    const cipher = full.slice(NONCE_LENGTH);
    const msg = nacl.box.open(cipher, nonce, senderPublicKey, walletSecretKeyBytes);
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
    // normalizeRequestItems guarantees a supported, non-empty list that always
    // includes ton_addr, so this loop can never leave `items` empty.
    for (const item of normalizeRequestItems(requestedItems)) {
      if (item.name === "ton_addr") {
        items.push(this.buildAddressItem());
      } else if (item.name === "ton_proof") {
        items.push(await this.buildProofItem(item.payload, domain));
      }
    }
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
    const { dAppPubKey, manifest, manifestUrl, items } = assertPrepared(prepared);
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
    const { dAppPubKey } = assertPrepared(prepared);
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

  /**
   * Answer a bridge request the wallet cannot service.
   *
   * Requests other than `connect` (notably `sendTransaction`) are delivered to
   * the UI, but there was no bridge reply path at all — so a connected dApp that
   * asked the wallet to sign would wait forever with no error and no timeout.
   * Replying with an explicit error lets the dApp surface a real message.
   *
   * A dApp-initiated sign-and-send flow is the natural follow-up; until one
   * exists, an honest rejection is the correct behaviour.
   */
  async respondError(dAppPubKey, requestId, message) {
    const sessions = await this.loadSessions();
    const session = sessions[dAppPubKey];
    if (!session) return { status: false, reason: "no-session" };

    const event = {
      event: "sendTransaction_error",
      id: requestId ?? this.eventId++,
      payload: {
        code: 400,
        message: message || "This request is not supported by NileVault",
        data: null,
      },
    };

    const body = this.boxEncrypt(
      event,
      dAppPubKey,
      hexToBytes(session.walletSecretKey),
    );
    try {
      await this.sendToBridge(session.walletPublicKey, dAppPubKey, body);
      return { status: true };
    } catch (error) {
      return { status: false, reason: error?.message || "publish-failed" };
    }
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
