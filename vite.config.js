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
  optimizeDeps: {
    // Only scan the real app entry. Without this, Vite's dep scanner globs
    // every *.html under the project root — including electron-builder output
    // (dist/win-unpacked/LICENSES.chromium.html) and the preview tool's
    // _preview.html — which breaks the node-polyfills buffer-shim resolution.
    entries: ["index.html"],
    // Pre-bundle the heavy / CommonJS deps in a single pass so Vite's dep
    // optimizer doesn't discover them incrementally mid-load and thrash
    // (which surfaces as 504 "Outdated Optimize Dep" in the browser preview).
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "@tanstack/react-query",
      "react-hot-toast",
      "react-icons/hi2",
      "qrcode.react",
      "radix-ui",
      "class-variance-authority",
      "clsx",
      "tailwind-merge",
      "copy-to-clipboard",
      "buffer",
      "tweetnacl",
      "@scure/base",
      "@noble/hashes/scrypt.js",
      "@noble/ciphers/webcrypto.js",
      "@noble/ciphers/utils.js",
      "@ton/core",
      "@ton/crypto",
      "@ton/ton",
    ],
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
