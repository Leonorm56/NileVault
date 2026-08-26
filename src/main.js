const { app, BrowserWindow, ipcMain, net, dialog, Menu } = require("electron");
const path = require("path");
const fs = require("fs");

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 720,
    show: false,
    title: "NileVault",
    icon: path.join(app.getAppPath(), "src/renderer/assets/images/nilevault-logo.jpg"),
    backgroundColor: "#040a14",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.key === "F12" && input.type === "keyDown") {
      mainWindow.webContents.toggleDevTools();
    }
  });

  if (!app.isPackaged && process.env.VITE_DEV) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    const distPath = path.join(app.getAppPath(), "app", "index.html");
    mainWindow.loadFile(distPath);
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  loadStore(); // run migration early
  createWindow();
});

app.on("window-all-closed", () => app.quit());

// ── IPC: Network Connectivity Check (informational, non-blocking) ──
// Runs the probes concurrently with a short timeout and never rejects.
// The renderer treats the result as advisory — it always offers Continue.
ipcMain.handle("check-connectivity", async () => {
  const endpoints = [
    { name: "TON API", url: "https://tonapi.io/v2/system/config" },
    { name: "Toncenter", url: "https://toncenter.com/api/v2/getConfig" },
    {
      name: "TON Connect Bridge",
      url: "https://bridge.tonapi.io/bridge/events?client_id=test",
    },
  ];

  const results = await Promise.all(
    endpoints.map(async (ep) => {
      const start = Date.now();
      try {
        const res = await net.fetch(ep.url, {
          signal: AbortSignal.timeout(3000),
        });
        return {
          name: ep.name,
          ok: res.status < 400 || res.status === 404,
          status: `${res.status}`,
          latency: Date.now() - start,
        };
      } catch (err) {
        return {
          name: ep.name,
          ok: false,
          status: err.message || String(err),
          latency: Date.now() - start,
        };
      }
    }),
  );

  return { ok: results.some((r) => r.ok), results };
});

// ── Storage: flat key-value blob persisted to vault.json ──────────
// The renderer owns all crypto; main is a dumb, in-memory-cached KV
// store. Only the encrypted seed material is ciphertext — addresses,
// public keys and the wallet registry are plaintext so the picker can
// render before the vault is unlocked.
const STORE_PATH = path.join(app.getPath("userData"), "vault.json");
const LEGACY_PATH = path.join(app.getPath("userData"), "vault.legacy.json");

let store = null;

function loadStore() {
  if (store) return store;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {
    raw = {};
  }

  // Legacy migration: the previous NileVault kept a top-level `wallets`
  // array whose seeds were encrypted under per-wallet, never-verified
  // passwords. Those seeds can't be auto-migrated to the single-vault
  // model, so preserve the old file and start clean.
  if (
    raw &&
    typeof raw === "object" &&
    Array.isArray(raw.wallets) &&
    !raw["shared:nile-wallet:vault"] &&
    !raw["nilevault:wallets"]
  ) {
    try {
      fs.copyFileSync(STORE_PATH, LEGACY_PATH);
    } catch {
      /* best-effort */
    }
    raw = {};
    try {
      fs.writeFileSync(STORE_PATH, JSON.stringify(raw, null, 2));
    } catch {
      /* best-effort */
    }
  }

  store = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return store;
}

function persist() {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

ipcMain.handle("kv-get", (_e, key) => {
  const s = loadStore();
  return key in s ? s[key] : undefined;
});

ipcMain.handle("kv-set", (_e, { key, value }) => {
  const s = loadStore();
  s[key] = value;
  persist();
  return { ok: true };
});

ipcMain.handle("kv-remove", (_e, key) => {
  const s = loadStore();
  delete s[key];
  persist();
  return { ok: true };
});

ipcMain.handle("kv-get-all", () => {
  return { ...loadStore() };
});

ipcMain.handle("get-version", () => app.getVersion());

// ── IPC: Native file dialogs for vault backup / restore ──────────
ipcMain.handle("save-backup-file", async (_e, { defaultPath, content }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultPath || "nilevault-backup.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
    title: "Save Vault Backup",
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, content, "utf8");
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle("open-backup-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: "JSON", extensions: ["json"] }],
    title: "Select Vault Backup",
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths?.length) return { canceled: true };
  const content = fs.readFileSync(result.filePaths[0], "utf8");
  return { canceled: false, content };
});
