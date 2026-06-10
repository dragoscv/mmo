import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { useUiStore } from "./state/ui-store";
import "./styles.css";

// Apply the persisted theme before first paint to avoid a flash.
useUiStore.getState().applyActiveTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
