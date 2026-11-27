import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { SpikeGate } from "./SpikeGate.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Application root is missing");

createRoot(root).render(
  <SpikeGate>
    <App />
  </SpikeGate>,
);

// Installable as an app (COD-244). The worker caches nothing (`public/sw.js`): without it the app still runs.
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error: unknown) => {
      console.error("Service worker registration failed", error);
    });
  });
}
