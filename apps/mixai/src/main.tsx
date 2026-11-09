import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "@mmo/ui/theme";
import { TooltipProvider } from "@mmo/ui";
import { App } from "./App";
import { AppI18nProvider } from "./i18n";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PopoutApp, popoutPanel } from "./shell/PopoutApp";
import "./styles.css";

// Second windows (`window_pop_out`) render a single panel.
const popout = popoutPanel();

// Theme prefs are applied to <html> before first paint by /prehydrate.js;
// ThemeProvider re-applies them idempotently and keeps them in sync.
ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <ThemeProvider>
            <AppI18nProvider>
                <TooltipProvider>
                    <ErrorBoundary>{popout ? <PopoutApp panel={popout} /> : <App />}</ErrorBoundary>
                </TooltipProvider>
            </AppI18nProvider>
        </ThemeProvider>
    </React.StrictMode>,
);
