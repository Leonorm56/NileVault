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

/** Navy/gold treatment for every toast, matching the app surfaces. */
const TOAST_STYLE = {
  background: "rgba(11, 21, 38, 0.97)",
  color: "#f0f4fa",
  border: "1px solid rgba(212, 168, 67, 0.28)",
  borderRadius: "12px",
  backdropFilter: "blur(14px)",
  fontSize: "13px",
  fontWeight: 600,
  padding: "10px 14px",
  maxWidth: "420px",
  boxShadow: "0 16px 40px -16px rgba(0, 0, 0, 0.8)",
};

const queryClient = createQueryClient();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster
        position="top-center"
        gutter={8}
        containerStyle={{ zIndex: 100, top: 68 }}
        toastOptions={{
          duration: 2600,
          style: TOAST_STYLE,
          success: { iconTheme: { primary: "#3ecf8e", secondary: "#040a14" } },
          error: {
            iconTheme: { primary: "#e5484d", secondary: "#040a14" },
            duration: 4200,
          },
          loading: { duration: Infinity },
        }}
      />
    </QueryClientProvider>
  </React.StrictMode>,
);
