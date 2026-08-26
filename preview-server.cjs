/**
 * Tiny dependency-free static file server for previewing a *production* build
 * (`app-preview/`, produced by `npm run build:web-preview`).
 *
 * Why not the Vite dev server? `vite-plugin-node-polyfills@0.28` is incompatible
 * with Vite 6's dev dep-optimizer (its buffer-shim alias fails inside esbuild),
 * so the dev server can't boot here — but the Rollup production build works
 * fine. This serves that build so the UI can be viewed/iterated in a browser.
 *
 * Reads the port from $PORT (set by the preview harness); falls back to 5180.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "app-preview");
const PORT = Number(process.env.PORT) || 5180;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function sendFile(res, filePath, status = 200) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(status, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(ROOT, urlPath);

  // Contain path traversal.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback — this app has a single entry.
      sendFile(res, path.join(ROOT, "index.html"));
      return;
    }
    sendFile(res, filePath);
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`preview-server: http://localhost:${PORT} → app-preview/`);
});
