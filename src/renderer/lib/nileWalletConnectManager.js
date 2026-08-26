import NileWalletConnect from "./NileWalletConnect.js";
import storage from "./storage.js";
import { getKeyPair } from "./nileWallet.js";

/**
 * TON Connect manager (renderer-hosted).
 *
 * In the NileChain extension this lived in the MV3 service worker because the
 * popup was ephemeral and the bridge EventSource had to outlive it. NileVault's
 * BrowserWindow is persistent, so the bridge runs here in the renderer — which
 * also keeps every secret in one place: `approve` signs `ton_proof` with the
 * account key derived from the decrypted seed, and that needs the in-memory
 * vault key held by `nileWallet.js` (reached via {@link getKeyPair}).
 *
 * One long-lived {@link NileWalletConnect} per account keeps its bridge
 * connection alive across requests. Instances are built bare (no keypair) so
 * subscribe/restore/reject/parse-link work without unlocking; `approve`
 * attaches the signing key lazily via {@link ensureKeys}.
 */

const connectCache = new Map();

/** accountId → Set<callback> for inbound bridge requests (e.g. sendTransaction). */
const requestListeners = new Map();

/**
 * Register a listener for inbound TON Connect requests on an account.
 * Returns an unsubscribe function.
 */
export function onConnectRequest(accountId, callback) {
  if (!requestListeners.has(accountId)) {
    requestListeners.set(accountId, new Set());
  }
  requestListeners.get(accountId).add(callback);
  return () => {
    requestListeners.get(accountId)?.delete(callback);
  };
}

function emitRequest(accountId, request) {
  const listeners = requestListeners.get(accountId);
  if (!listeners) return;
  for (const cb of listeners) {
    try {
      cb(request);
    } catch (e) {
      console.error("NileWallet connect listener error:", e);
    }
  }
}

function getConnect(accountId) {
  if (!connectCache.has(accountId)) {
    connectCache.set(
      accountId,
      new NileWalletConnect({
        storage,
        accountId,
        onRequest: (request) => emitRequest(accountId, request),
      }),
    );
  }
  return connectCache.get(accountId);
}

/** Attach the account's signing keypair to a connect instance (requires unlock). */
async function ensureKeys(connect, accountId) {
  if (!connect.keyPair) {
    const { keyPair, contract } = await getKeyPair(accountId);
    connect.keyPair = keyPair;
    connect.wallet = contract;
  }
  return connect;
}

const connectManager = {
  /** Parse a `tc://` universal link into a UI-ready connect request. */
  parseLink: async (accountId, link) => {
    const connect = getConnect(accountId);
    const prepared = await connect.prepareConnectRequest(link);
    return { status: true, prepared };
  },

  /** Approve a prepared connect request (signs ton_proof, opens the bridge). */
  approve: async (accountId, prepared) => {
    const connect = getConnect(accountId);
    await ensureKeys(connect, accountId);
    const result = await connect.approve(prepared);
    return { status: true, ...result };
  },

  /** Reject a prepared connect request. */
  reject: async (accountId, prepared) => {
    const connect = getConnect(accountId);
    await connect.reject(prepared);
    return { status: true };
  },

  /** Disconnect an active session and notify the dApp. */
  disconnect: async (accountId, dAppPubKey) => {
    const connect = getConnect(accountId);
    await connect.disconnect(dAppPubKey);
    return { status: true };
  },

  /** (Re)subscribe to the bridge for this account's persisted sessions. */
  subscribe: async (accountId) => {
    const connect = getConnect(accountId);
    const clientIds = await connect.subscribe();
    return { status: true, clientIds };
  },

  /** Alias of subscribe — re-open the bridge for an account after a restart. */
  restore: async (accountId) => {
    const connect = getConnect(accountId);
    const clientIds = await connect.subscribe();
    return { status: true, clientIds };
  },

  /** List active sessions (connected apps) for an account. */
  sessions: async (accountId) => {
    const connect = getConnect(accountId);
    const sessions = await connect.loadSessions();
    return {
      status: true,
      sessions: Object.values(sessions).map((s) => ({
        dAppPubKey: s.dAppPubKey,
        manifest: s.manifest,
        connectedAt: s.connectedAt,
      })),
    };
  },

  /** Register an inbound-request listener for an account. */
  onConnectRequest,

  /**
   * Re-open the bridge for every account with persisted sessions. Called after
   * unlock / app start so previously-connected dApps reconnect without needing
   * re-approval (each session stores its own x25519 secret — no vault key
   * required).
   */
  restoreAll: async () => {
    const all = await storage.getAll();
    const suffix = ":nile-wallet:sessions";

    for (const key of Object.keys(all)) {
      if (!key.startsWith("account-") || !key.endsWith(suffix)) continue;
      const sessions = all[key];
      if (!sessions || !Object.keys(sessions).length) continue;

      const accountId = key.slice("account-".length, key.length - suffix.length);
      try {
        await getConnect(accountId).subscribe();
      } catch (e) {
        console.error("NileWallet restore failed for", accountId, e);
      }
    }
  },

  /** Tear down a live bridge connection (used when a wallet is deleted). */
  teardown: (accountId) => {
    const connect = connectCache.get(accountId);
    if (connect) {
      connect.unsubscribe();
      connectCache.delete(accountId);
    }
    requestListeners.delete(accountId);
  },

  /** Tear down every live bridge connection (used on lock). */
  teardownAll: () => {
    for (const connect of connectCache.values()) {
      connect.unsubscribe();
    }
    connectCache.clear();
  },
};

export default connectManager;
