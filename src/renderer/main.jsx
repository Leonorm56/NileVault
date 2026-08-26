import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "react-hot-toast";
import App from "./App.jsx";
import { createQueryClient } from "./lib/createQueryClient.js";
import "./index.css";

// Browser-preview support: when there is no Electron bridge (i.e. the renderer
// is opened in a plain browser), install an in-memory mock so the UI and vault
// flow can run. Enabled in dev, or in a build made with VITE_PREVIEW=1. Both
// flags are statically false in a normal production build, so the whole block —
// and the mock module — is stripped from the packaged app.
if (
  (import.meta.env.DEV || import.meta.env.VITE_PREVIEW) &&
  !window.nilevault
) {
  const { installDevBridgeMock } = await import("./lib/devBridgeMock.js");
  installDevBridgeMock();
}

const queryClient = createQueryClient();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster
        position="top-center"
        toastOptions={{
          duration: 2000,
          loading: {
            duration: Infinity,
          },
        }}
      />
    </QueryClientProvider>
  </React.StrictMode>
);
