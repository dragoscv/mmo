import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "@mmo/ui/theme";
import { TooltipProvider } from "@mmo/ui";
import { App } from "./App";
import { AppI18nProvider } from "./i18n";
import { handleEngineExit } from "./store";
import { isTauri, onEngineExit } from "./lib/tauri";
import "./styles.css";

if (isTauri()) void onEngineExit((e) => handleEngineExit(e.message));

// Theme prefs are applied to <html> before first paint by ./prehydrate.js; ThemeProvider keeps them in sync.
ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <ThemeProvider>
            <AppI18nProvider>
                <TooltipProvider>
                    <App />
                </TooltipProvider>
            </AppI18nProvider>
        </ThemeProvider>
    </React.StrictMode>,
);
