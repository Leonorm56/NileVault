/**
 * Storage adapter — a `chrome.storage.local`-shaped façade backed by the
 * main-process key-value store over IPC (`window.nilevault.kv*`).
 *
 * Shape matches the adapter the ported NileWallet code was written against:
 * `get(key, default)`, `set(key, value)`, `remove(key)`. `getAll()` is a
 * convenience extension used for exports/diagnostics.
 *
 * A missing key resolves to `undefined` over IPC (Electron's structured clone
 * preserves it), which we translate to the caller's default — matching the
 * reference `key in result ? result[key] : defaultValue` semantics.
 */
// Read the bridge lazily on every call rather than capturing it at module
// load. In Electron the preload sets `window.nilevault` before the renderer
// runs, so either style works there — but reading lazily also lets a dev-only
// browser mock (installed in main.jsx) be picked up regardless of import order.
const getBridge = () =>
  typeof window !== "undefined" ? window.nilevault : undefined;

const storage = {
  async get(key, defaultValue = null) {
    const bridge = getBridge();
    if (!bridge) return defaultValue;
    const value = await bridge.kvGet(key);
    return value === undefined ? defaultValue : value;
  },

  async set(key, value) {
    const bridge = getBridge();
    if (!bridge) return;
    await bridge.kvSet(key, value);
  },

  async remove(key) {
    const bridge = getBridge();
    if (!bridge) return;
    await bridge.kvRemove(key);
  },

  async getAll() {
    const bridge = getBridge();
    if (!bridge) return {};
    return await bridge.kvGetAll();
  },
};

export default storage;
