/**
 * Dev-only mock of the Electron preload bridge (`window.nilevault`).
 *
 * This lets the renderer run in a plain browser (e.g. `npm run dev` opened
 * directly, or a preview pane) so the UI and the full client-side vault flow
 * — real WebCrypto over a localhost secure context — can be exercised without
 * packaging Electron. It is installed ONLY when `import.meta.env.DEV` is true
 * and no real bridge is present, so it is dead-code-eliminated from production
 * builds and can never activate inside the packaged app (preload always sets
 * `window.nilevault` first there).
 *
 * The KV map is persisted to `localStorage` so vault/wallet state survives a
 * page reload — which is exactly what "lock on restart" testing needs.
 */
const KV_KEY = "nilevault:dev-kv";

function readMap() {
  try {
    return JSON.parse(localStorage.getItem(KV_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeMap(map) {
  try {
    localStorage.setItem(KV_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota / serialization errors in the mock */
  }
}

export function installDevBridgeMock() {
  window.nilevault = {
    getVersion: async () => "dev",

    // Mirrors the real main-process probe shape: { ok, results:[{name,ok,status,latency}] }.
    checkConnectivity: async () => ({
      ok: true,
      results: [
        { name: "TON API (tonapi.io)", ok: true, status: 200, latency: 41 },
        { name: "Toncenter", ok: true, status: 200, latency: 87 },
        { name: "TON Connect Bridge", ok: true, status: 200, latency: 62 },
      ],
    }),

    // Missing keys resolve to `undefined` to match Electron IPC semantics
    // (storage.js translates undefined -> the caller's default).
    kvGet: async (key) => {
      const map = readMap();
      return key in map ? map[key] : undefined;
    },
    kvSet: async (key, value) => {
      const map = readMap();
      map[key] = value;
      writeMap(map);
      return true;
    },
    kvRemove: async (key) => {
      const map = readMap();
      delete map[key];
      writeMap(map);
      return true;
    },
    kvGetAll: async () => readMap(),
  };

  // eslint-disable-next-line no-console
  console.info(
    "%c[NileVault] dev bridge mock active — browser preview mode (no Electron).",
    "color:#D4A843;font-weight:bold",
  );
}
