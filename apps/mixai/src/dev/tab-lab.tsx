/**
 * Development only: render ONE deck tab body alone in a box of a chosen size (bottom-right
 * corner, dashed outline), independent of the deck's own layout. Driven by
 * `window.__decks.tabLab(deck, tab, w, h, compact)`; `tabLab()` removes it.
 */
import { createRoot } from "react-dom/client";
import { create } from "zustand";
import { TooltipProvider } from "@mmo/ui";
import { ThemeProvider } from "@mmo/ui/theme";
import { AppI18nProvider } from "@/i18n";
import type { DeckId } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { DeckTabBody } from "@/components/DeckTabBody";
import type { DeckTab } from "@/components/deck-ui-store";

export interface TabLabBox {
    deck: DeckId;
    tab: DeckTab;
    w: number;
    h: number;
    compact: boolean;
}

export const useTabLab = create<{ box: TabLabBox | null; set: (box: TabLabBox | null) => void }>((set) => ({
    box: null,
    set: (box) => set({ box }),
}));

function TabLab() {
    const box = useTabLab((s) => s.box);
    const deck = useMixerStore((s) => s.deck(box?.deck ?? "a"));
    if (!box) return null;
    const accent = `var(--deck-${box.deck})`;
    return (
        <div
            id="tab-lab"
            data-deck-scope
            style={{
                position: "fixed",
                right: 8,
                bottom: 30,
                width: box.w,
                height: box.h,
                zIndex: 40,
                overflow: "hidden",
                outline: "1px dashed var(--warning)",
                background: "var(--card)",
                ["--deck" as string]: accent,
            }}
        >
            <DeckTabBody deckId={box.deck} deck={deck} accent={accent} tab={box.tab} compact={box.compact} />
        </div>
    );
}

let mounted = false;
export function mountTabLab(): void {
    if (mounted) return;
    mounted = true;
    const el = document.createElement("div");
    document.body.appendChild(el);
    createRoot(el).render(
        <ThemeProvider>
            <AppI18nProvider>
                <TooltipProvider>
                    <TabLab />
                </TooltipProvider>
            </AppI18nProvider>
        </ThemeProvider>,
    );
}
