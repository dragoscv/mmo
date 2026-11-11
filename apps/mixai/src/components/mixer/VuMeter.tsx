import { useEffect, useRef, type CSSProperties } from "react";
import { cn } from "@mmo/ui";
import type { DeckId } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { useT } from "@/i18n";
import { useElementSize } from "../panel-ui";
import { VU, cellCount, cellZone, vuDbText, vuLit, vuLitClip } from "./vu-math";

/**
 * Segmented level meter (`dk-led` cells: green / amber / red by level, plus a peak-hold cell).
 *
 * The level never goes through React, and it costs ONE style write per change, on one node:
 * the meter is two static layers of cells (all off, all lit) and the lit layer is clipped to the
 * current level (`clip-path`, not inherited: no cell is restyled). The peak cell is one more node
 * moved with a custom property. The accessible value is written at most twice a second.
 * So a playing deck costs about one write per engine snapshot and a silent one costs nothing
 * (no timer, no frame loop, no render).
 *
 * `columns={2}` draws the master meter as two columns; the engine reports one peak for the
 * master bus, so both columns show the same level.
 */
export function VuMeter({
    source,
    label,
    orientation = "vertical",
    columns = 1,
    className,
}: {
    /** Which level: the master bus or one deck (post-fader). */
    source: "master" | DeckId;
    /** Accessible name. */
    label: string;
    orientation?: "vertical" | "horizontal";
    columns?: 1 | 2;
    className?: string;
}) {
    const t = useT();
    const [ref, size] = useElementSize<HTMLDivElement>();
    const litLayer = useRef<HTMLDivElement>(null);
    const peakCell = useRef<HTMLDivElement>(null);
    const cells = cellCount(orientation === "vertical" ? size.h : size.w);
    const silent = t("mix.vuSilent");

    useEffect(() => {
        const root = ref.current;
        const on = litLayer.current;
        const pk = peakCell.current;
        if (!root || !on || !pk || cells === 0) return;

        let lit = 0;
        let peak = 0;
        let peakAt = 0;
        let holdTimer = 0;
        let last = Number.NaN;
        // Accessible value: what is on the node (`said*`), what it should be (`want*`), and the
        // rate limiter: it may lag the cells by up to `VU.ariaMs`, then settles on the last value.
        let said = "";
        let saidNow = 0;
        let want = "";
        let wantNow = 0;
        let ariaTimer = 0;

        const say = () => {
            ariaTimer = 0;
            if (want === said && wantNow === saidNow) return;
            said = want;
            saidNow = wantNow;
            root.setAttribute("aria-valuenow", String(wantNow));
            root.setAttribute("aria-valuetext", want);
            ariaTimer = window.setTimeout(say, VU.ariaMs);
        };
        const setPeak = (next: number) => {
            if (next === peak) return;
            const zone = next > 0 ? cellZone(next - 1, cells) : "none";
            if (zone !== (peak > 0 ? cellZone(peak - 1, cells) : "none")) pk.setAttribute("data-zone", zone);
            if (next > 0) pk.style.setProperty("--peak", String(next - 1));
            peak = next;
        };
        const release = () => {
            holdTimer = 0;
            const wait = VU.holdMs - (performance.now() - peakAt);
            if (wait > 20) {
                holdTimer = window.setTimeout(release, wait);
                return;
            }
            // The held peak falls back to the current level; a silent meter arms nothing.
            setPeak(lit);
            if (lit > 0) {
                peakAt = performance.now();
                holdTimer = window.setTimeout(release, VU.holdMs);
            }
        };
        const apply = (level: number) => {
            if (level === last) return;
            last = level;
            const n = vuLit(level, cells);
            if (n !== lit) {
                lit = n;
                on.style.clipPath = vuLitClip(n, cells, orientation);
                wantNow = Math.round((n / cells) * 100);
                want = n === 0 ? silent : vuDbText(level);
                if (!ariaTimer) say();
            }
            if (n > 0 && n >= peak) {
                peakAt = performance.now();
                setPeak(n);
                if (!holdTimer) holdTimer = window.setTimeout(release, VU.holdMs);
            }
        };

        const read = (s: ReturnType<typeof useMixerStore.getState>) => (source === "master" ? s.masterVu : s.deck(source).vu);
        root.setAttribute("aria-valuenow", "0");
        root.setAttribute("aria-valuetext", silent);
        said = silent;
        want = silent;
        apply(read(useMixerStore.getState()));
        const off = useMixerStore.subscribe((s) => apply(read(s)));
        return () => {
            off();
            window.clearTimeout(holdTimer);
            window.clearTimeout(ariaTimer);
            on.style.clipPath = "";
            pk.setAttribute("data-zone", "none");
        };
    }, [ref, source, cells, silent, orientation]);

    const layer = (lit: boolean) =>
        Array.from({ length: columns }, (_, c) => (
            <div key={c} className="mx-vu-col">
                {Array.from({ length: cells }, (_, i) => (
                    <i key={i} className="dk-led mx-vu-cell" data-zone={cellZone(i, cells)} data-on={lit ? "true" : undefined} />
                ))}
            </div>
        ));

    return (
        <div
            ref={ref}
            role="meter"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            data-orient={orientation}
            className={cn("mx-vu", className)}
            style={{ "--vu-cols": columns, "--vu-cells": Math.max(1, cells) } as CSSProperties}
        >
            <div aria-hidden className="mx-vu-cols">
                {layer(false)}
            </div>
            <div ref={litLayer} aria-hidden className="mx-vu-cols mx-vu-lit">
                {layer(true)}
            </div>
            <div ref={peakCell} aria-hidden className="mx-vu-peak" data-zone="none">
                {Array.from({ length: columns }, (_, c) => (
                    <i key={c} />
                ))}
            </div>
        </div>
    );
}
