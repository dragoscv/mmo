import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "@mmo/ui/theme";
import { TooltipProvider } from "@mmo/ui";
import { App } from "./App";
import { AppI18nProvider } from "./i18n";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PopoutApp, popoutPanel } from "./shell/PopoutApp";
import { DEFAULT_LOOK, applyLook, migrateLookOnce } from "./look/look";
import { renderActiveSkinEarly } from "./packs/pack-store";
import "./styles.css";

// Decks look layer: default look on <html> before React paints; the active skin may switch it
// (pack-store). Existing installs move to the new default once.
applyLook(DEFAULT_LOOK);
migrateLookOnce();
// A built-in active skin (e.g. "Glass (classic)") shows before the first paint, not after it.
renderActiveSkinEarly();

// Development only (stripped from production bundles).
if (import.meta.env.DEV) {
    // React's development build logs every component render as a User Timing measure. With
    // the 30 Hz engine snapshot that was ~3 800 `performance.measure` calls a second: 62 % of
    // the main thread and 15–40 fps on a 12th-gen i5, against 120 fps without them (CPU
    // profile, 2026-11-10). Production React makes no such calls.
    performance.measure = (() => undefined) as unknown as Performance["measure"];
    // `window.__decks` for remote debugging.
    void import("./dev/dev-hooks");
}

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
