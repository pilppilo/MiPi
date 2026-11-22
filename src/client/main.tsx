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
