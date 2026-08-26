/**
 * NileWallet client
 *
 * A thin façade over the renderer-hosted NileWallet stack. Vault, wallet,
 * token, transfer, backup and registry ops call {@link nileWallet} directly;
 * TON Connect calls the renderer-hosted {@link connectManager} (which in the
 * NileChain extension lived in the service worker). Every call is normalized
 * through {@link call} so the UI sees typed lock / bad-passphrase errors.
 */

import nileWallet from "./nileWallet.js";
import connectManager from "./nileWalletConnectManager.js";

/** Error thrown when the vault key isn't cached — UI should prompt to unlock. */
export class NileWalletLockedError extends Error {
  constructor() {
    super("needs-unlock");
    this.name = "NileWalletLockedError";
    this.code = "needs-unlock";
  }
}

/** Error thrown when an entered passphrase doesn't match the vault. */
export class NileWalletBadPassphraseError extends Error {
  constructor() {
    super("bad-passphrase");
    this.name = "NileWalletBadPassphraseError";
    this.code = "bad-passphrase";
  }
}

function wrapError(err) {
  if (err?.message === "needs-unlock") throw new NileWalletLockedError();
  if (err?.message === "bad-passphrase") throw new NileWalletBadPassphraseError();
  throw err;
}

function call(fn, ...args) {
  return Promise.resolve()
    .then(() => fn(...args))
    .catch(wrapError);
}

const nileWalletClient = {
  /* ---- vault ---- */
  vaultStatus: () => call(nileWallet.vaultStatus),
  unlock: (password) =>
    call(nileWallet.unlock, password).then((res) => {
      // Re-open bridges for any previously-connected dApps (fire-and-forget).
      connectManager.restoreAll().catch(() => {});
      return res;
    }),
  lock: () => {
    connectManager.teardownAll();
    return call(nileWallet.lock);
  },
  changePassphrase: (oldPassword, newPassword) =>
    call(nileWallet.changePassphrase, { oldPassword, newPassword }),

  /* ---- wallet registry (picker) ---- */
  listWallets: () => call(nileWallet.listWallets),
  createWallet: (name) => call(nileWallet.createWallet, name),
  renameWallet: (accountId, name) =>
    call(nileWallet.renameWallet, accountId, name),
  deleteWallet: (accountId) => {
    connectManager.teardown(accountId);
    return call(nileWallet.deleteWallet, accountId);
  },

  /* ---- wallet ---- */
  get: (accountId) => call(nileWallet.get, accountId),
  generate: (accountId) => call(nileWallet.generate, accountId),
  importWallet: (accountId, phrase) =>
    call(nileWallet.importWallet, accountId, phrase),
  revealSeed: (accountId) => call(nileWallet.revealSeed, accountId),
  clear: (accountId) => call(nileWallet.clear, accountId),
  balance: (accountId) => call(nileWallet.balance, accountId),

  /* ---- custom tokens (Jettons) ---- */
  listTokens: (accountId) => call(nileWallet.listTokens, accountId),
  addToken: (accountId, address) =>
    call(nileWallet.addToken, accountId, address),
  removeToken: (accountId, address) =>
    call(nileWallet.removeToken, accountId, address),
  tokenBalance: (accountId, token) =>
    call(nileWallet.tokenBalance, accountId, token),

  /* ---- transfers ---- */
  estimateTransfer: (accountId, params) =>
    call(nileWallet.estimateTransfer, accountId, params),
  sendTransfer: (accountId, params) =>
    call(nileWallet.sendTransfer, accountId, params),

  /* ---- backup / restore ---- */
  backup: (password) => call(nileWallet.backup, { password }),
  restorePreview: (password, json) =>
    call(nileWallet.restorePreview, { password, json }),
  restoreApply: (password, json, overwrite) =>
    call(nileWallet.restoreApply, { password, json, overwrite }),

  /* ---- TON Connect (renderer-hosted bridge) ---- */
  parseLink: (accountId, link) => call(connectManager.parseLink, accountId, link),
  approve: (accountId, prepared) =>
    call(connectManager.approve, accountId, prepared),
  reject: (accountId, prepared) =>
    call(connectManager.reject, accountId, prepared),
  disconnect: (accountId, dAppPubKey) =>
    call(connectManager.disconnect, accountId, dAppPubKey),
  subscribe: (accountId) => call(connectManager.subscribe, accountId),
  restore: (accountId) => call(connectManager.restore, accountId),
  sessions: (accountId) => call(connectManager.sessions, accountId),

  /**
   * Subscribe to inbound TON Connect requests for an account (e.g. a dApp's
   * sendTransaction). Synchronous — returns an unsubscribe function. Replaces
   * the extension's `chrome.runtime.onMessage` listener.
   */
  onConnectRequest: (accountId, cb) =>
    connectManager.onConnectRequest(accountId, cb),
};

export default nileWalletClient;
