/**
 * Body of a deck's lower tab area: hot cues / loops / FX / stems / grid. The deck gives it a
 * box and it fills it without scrolling: each body shows its roomy form when that fits and
 * otherwise one row with the rest in a popover (`deck-tabs/use-fit.ts`). `compact` = the
 * compact deck tier (fewer pads, loop row under them).
 */
import { Suspense, lazy, memo } from "react";
import { Palette } from "lucide-react";
import { Skeleton } from "@mmo/ui";
import type { DeckId, DeckState } from "@/bridge/types";
import { useT } from "@/i18n";
import { HotCuePads, LoopRow, LoopsBody } from "./PerformancePads";
import { ColorFx, ColorFxKnob } from "./ColorFx";
import type { DeckTab } from "./deck-ui-store";
import { MorePopover } from "./panel-ui";
import { deckPropsEqual } from "./deck-tabs/tab-math";
import { useFitLevel, useTouchMode } from "./deck-tabs/use-fit";

// Tab bodies not needed for first paint of the transport.
const StemControls = lazy(() => import("./StemControls").then((m) => ({ default: m.StemControls })));
const FxPanel = lazy(() => import("./FxPanel").then((m) => ({ default: m.FxPanel })));
const GridEditor = lazy(() => import("./GridEditor").then((m) => ({ default: m.GridEditor })));

export interface DeckTabBodyProps {
    deckId: DeckId;
    deck: DeckState;
    /** The deck colour as a CSS value (`var(--deck-a)`). */
    accent: string;
    tab: DeckTab;
    compact?: boolean;
}

export function DeckTabBody({ deckId, deck, accent, tab, compact }: DeckTabBodyProps) {
    if (tab === "cues")
        return compact ? (
            <div className="dt-cues-compact">
                <HotCuePads deckId={deckId} deck={deck} accent={accent} count={4} />
                <LoopRow deckId={deckId} deck={deck} short />
            </div>
        ) : (
            <HotCuePads deckId={deckId} deck={deck} accent={accent} count={8} className="h-full" />
        );
    if (tab === "loops") return <LoopsBody deckId={deckId} deck={deck} accent={accent} />;
    if (tab === "fx")
        return (
            <Suspense fallback={<Skeleton className="h-full w-full" />}>
                <FxTab deckId={deckId} deck={deck} accent={accent} />
            </Suspense>
        );
    if (tab === "grid")
        return (
            <Suspense fallback={<Skeleton className="h-full w-full" />}>
                <GridEditor deck={deck} className="h-full min-h-0" />
            </Suspense>
        );
    return (
        <Suspense fallback={<Skeleton className="h-full w-full" />}>
            <StemControls deckId={deckId} deck={deck} accent={accent} className="h-full" />
        </Suspense>
    );
}

interface FxTabProps {
    deckId: DeckId;
    deck: DeckState;
    accent: string;
}

/**
 * FX tab: the deck FX unit and the colour FX, in the roomiest form that fits (nothing is
 * removed): 0 = deck FX over the colour FX row; 1 = one row, the colour FX type in a popover
 * next to its knob; 2 = one row, the echo time in that popover too (touch mode, narrow box).
 */
function FxTabImpl({ deckId, deck, accent }: FxTabProps) {
    const t = useT();
    const touch = useTouchMode();
    // In a parent without a height (the deck's popover) nothing can stick out: it stays roomy.
    const [ref, level] = useFitLevel<HTMLDivElement>(2);
    const label = t(level === 2 ? "decktabs.fxMore" : "fx.color.title");
    return (
        <div ref={ref} className="dt-fxtab" data-mode={level === 0 ? "rows" : "row"}>
            <FxPanel deckId={deckId} deck={deck} accent={accent} part={level < 2 ? "all" : "main"} />
            {level === 0 ? (
                <div className="dt-fx-color">
                    <ColorFx deckId={deckId} accent={accent} compact />
                </div>
            ) : (
                <div className="dt-fx-color-mini">
                    <ColorFxKnob deckId={deckId} accent={accent} size={touch ? 44 : 24} showValue={false} />
                    <MorePopover label={label} icon={<Palette size={13} aria-hidden />} side="top">
                        <div className="dt-fx-pop" data-deck-scope="" style={{ ["--deck" as string]: accent }}>
                            {level === 2 && <FxPanel deckId={deckId} deck={deck} accent={accent} part="beats" />}
                            <ColorFx deckId={deckId} accent={accent} />
                        </div>
                    </MorePopover>
                </div>
            )}
        </div>
    );
}
const FxTab = memo(FxTabImpl, deckPropsEqual<DeckState, FxTabProps>(["fxKind", "fxWet", "fxBeats"]));
