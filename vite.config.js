import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import path from "path";

function stripCrossorigin() {
  return {
    name: "strip-crossorigin",
    transformIndexHtml(html) {
      return html.replace(/ crossorigin/g, "");
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), stripCrossorigin(), nodePolyfills()],
  root: ".",
  base: "./",
  esbuild: {
    supported: {
      "top-level-await": true,
    },
  },
  /*
    Only the real app entry is scanned. Without this the dep scanner globs every
    *.html under the project root — including electron-builder output
    (dist/win-unpacked/LICENSES.chromium.html) and the preview tool's
    _preview.html — which breaks the node-polyfills buffer-shim resolution.

    There is deliberately no `optimizeDeps.include` list: it only existed to feed
    Vite's dev server, and that server cannot boot here (see the note in
    preview-server.cjs — vite-plugin-node-polyfills is incompatible with Vite 6's
    dev dep-optimizer). The working loop is `npm run dev` (build + Electron) or
    `npm run build:web-preview && npm run serve:web-preview` for browser checks.
  */
  optimizeDeps: {
    entries: ["index.html"],
  },
  build: {
    outDir: "app",
    emptyOutDir: true,
    modulePreload: false,
  },
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    strictPort: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/renderer"),
    },
  },
});
