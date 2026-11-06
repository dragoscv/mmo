import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applySqueeze } from "./lib/screen-format";
import { initPlatform } from "./platform";
import "./styles.css";
import "./ui/ui.css";

applySqueeze();
const el = document.getElementById("root");
if (!el) throw new Error("#root missing");
// Desktop resolves OS / host / LAN IP over IPC first (instant elsewhere).
void initPlatform().then(() => createRoot(el).render(<App />));
