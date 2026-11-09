/**
 * Tier context: the shell tells each panel which tier it got from the solver.
 * Components read it with `usePanelTier()` and must render without overflow
 * inside a rect at least as large as PANEL_SPECS[panel].min[tier].
 * Outside the shell (tests, pop-out windows) the default is "full".
 */
import { createContext, useContext, type ReactNode } from "react";
import type { Tier } from "./types.ts";

const TierContext = createContext<Tier>("full");

export function PanelTierProvider({ tier, children }: { tier: Tier; children: ReactNode }) {
    return <TierContext.Provider value={tier}>{children}</TierContext.Provider>;
}

export function usePanelTier(): Tier {
    return useContext(TierContext);
}
