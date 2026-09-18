import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, ToastProvider, Toaster, TooltipProvider } from "@mmo/ui";
import { CompanionI18nProvider } from "./i18n";
import { App } from "./App";
import "./styles.css";

/**
 * Theme: the shared ThemeProvider resolves `mode: "system"` through
 * `prefers-color-scheme`, which Electron already wires to `nativeTheme`
 * — so no `get-theme` / `theme-updated` IPC is needed for the renderer.
 * (main.ts keeps those handlers for the BrowserWindow backgroundColor.)
 */
createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <ThemeProvider>
            <CompanionI18nProvider>
                <ToastProvider>
                    <TooltipProvider>
                        <App />
                        <Toaster />
                    </TooltipProvider>
                </ToastProvider>
            </CompanionI18nProvider>
        </ThemeProvider>
    </StrictMode>,
);
