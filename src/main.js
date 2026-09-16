const {
  app,
  BrowserWindow,
  ipcMain,
  net,
  dialog,
  Menu,
  shell,
  session,
} = require("electron");
const path = require("path");
const fs = require("fs");

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 420,
    minHeight: 620,
    show: false,
    title: "NileVault",
    icon: path.join(app.getAppPath(), "build", "icon.ico"),
    backgroundColor: "#040a14",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  /*
    External links open in the user's browser, and nothing may navigate the
    wallet window away from its own document. Without this, a manifest URL or an
    errant anchor could replace the wallet UI with remote content while the
    vault is unlocked.
  */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const current = mainWindow.webContents.getURL();
    if (url !== current) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });

  // DevTools only in unpackaged runs.
  if (!app.isPackaged) {
    mainWindow.webContents.on("before-input-event", (_event, input) => {
      if (input.key === "F12" && input.type === "keyDown") {
        mainWindow.webContents.toggleDevTools();
      }
    });
  }

  if (!app.isPackaged && process.env.VITE_DEV) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), "app", "index.html"));
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  /*
    A Content-Security-Policy for the renderer: only local scripts, styles and
    assets, plus the TON endpoints this wallet legitimately calls. Image sources
    stay open because tracked jettons supply their own icons.
  */
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const isDevServer = details.url.startsWith("http://localhost");
    const policy = [
      "default-src 'self'",
      isDevServer ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; ");

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });

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
let writePending = false;

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

/**
 * Persist the store off the critical path.
 *
 * Every key write used to rewrite the whole JSON file synchronously, which now
 * includes session maps and token lists alongside the encrypted seeds. Writes
 * are coalesced into a microtask so a burst of sets costs one file write.
 */
function persist() {
  if (writePending) return;
  writePending = true;
  queueMicrotask(() => {
    writePending = false;
    const snapshot = JSON.stringify(store, null, 2);
    fs.promises.writeFile(STORE_PATH, snapshot).catch(() => {
      /* a failed write must not take the app down */
    });
  });
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
  const filePath = result.filePaths[0];
  const content = fs.readFileSync(filePath, "utf8");
  return {
    canceled: false,
    content,
    fileName: path.basename(filePath),
  };
});
