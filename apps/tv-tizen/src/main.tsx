import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applySqueeze } from "./lib/screen-format";
import "./styles.css";
import "./ui/ui.css";

applySqueeze();
const el = document.getElementById("root");
if (!el) throw new Error("#root missing");
createRoot(el).render(<App />);
