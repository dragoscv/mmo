/**
 * Shell hotkeys + automatic layout switching:
 * - Alt+1..8: layout snapshot slot (falls back to the n-th layout when the slot is empty).
 * - Ctrl/Cmd+Shift+S: stage mode.
 * - Controller connect (BLE MIDI connect event, or a USB MIDI port opened via
 *   engine.midiConnect): apply the layout mapped to that device name.
 * Announcements go to the shell status region (`announce`).
 */
import { useEffect } from "react";
import { subscribeBleMidi } from "@/bridge/events";
import { gigAllows } from "@/gig/gig-store";
import { useLayoutStore } from "@/layout/layout-store";
import { useUiStore } from "@/state/ui-store";
import { translate, useLocale } from "@/i18n";
import { create } from "zustand";

/** How long an announcement stays on screen unless the caller asks for longer. */
export const ANNOUNCE_MS = 2200;
/** Bounds of a caller's own duration (a sentence must be readable, and must go away). */
const ANNOUNCE_MIN_MS = 1000;
const ANNOUNCE_MAX_MS = 10_000;

interface Announce {
    text: string;
    /** Changes with every announcement, also when the text is the same (the status region re-inserts its node on it). */
    at: number;
    /** How long this announcement stays on screen. */
    ms: number;
    /** Say `text` in the shell status region; `ms` = time on screen (default `ANNOUNCE_MS`). */
    say: (text: string, ms?: number) => void;
}

export const useAnnounce = create<Announce>((set, get) => ({
    text: "",
    at: 0,
    ms: ANNOUNCE_MS,
    say: (text, ms) =>
        set({
            text,
            // Never the same value twice, so a repeated sentence is a new event.
            at: Math.max(Date.now(), get().at + 1),
            ms: typeof ms === "number" && Number.isFinite(ms) ? Math.min(ANNOUNCE_MAX_MS, Math.max(ANNOUNCE_MIN_MS, ms)) : ANNOUNCE_MS,
        }),
}));

function isEditable(el: EventTarget | null): boolean {
    return el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/** Resolve a slot ("1".."8") to a layout id: explicit snapshot first, else the n-th layout. */
export function slotLayoutId(slot: string, snapshots: Record<string, string>, allIds: string[]): string | null {
    if (snapshots[slot] && allIds.includes(snapshots[slot])) return snapshots[slot];
    const n = Number(slot);
    return Number.isInteger(n) && n >= 1 && n <= allIds.length ? allIds[n - 1]! : null;
}

/** Find the layout mapped to a device name (case-insensitive substring both ways). */
export function controllerLayoutId(device: string, map: Record<string, string>): string | null {
    const d = device.toLowerCase();
    for (const [name, id] of Object.entries(map)) {
        const n = name.toLowerCase().trim();
        if (n && (d.includes(n) || n.includes(d))) return id;
    }
    return null;
}

/** Returns true when the layout mapped to `device` was applied. */
export function applyControllerLayout(device: string, locale: "en" | "ro"): boolean {
    const ls = useLayoutStore.getState();
    const id = controllerLayoutId(device, ls.controllerLayouts);
    if (!id) return false;
    const l = ls.all().find((x) => x.id === id);
    if (!l) return false;
    // Gig lock: the layout does not change by itself during a set. The connect is counted for
    // the gig popover and NOT remembered: unlocking later does not switch the layout either.
    if (!gigAllows("controllerLayout")) return false;
    ls.setActive(id);
    useAnnounce.getState().say(translate(locale, "shell.controllerLayout", { device, name: l.name }));
    return true;
}

export function useShellHotkeys(): void {
    const locale = useLocale() as "en" | "ro";
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (isEditable(e.target)) return;
            if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-8]$/.test(e.code)) {
                const slot = e.code.slice(5);
                const ls = useLayoutStore.getState();
                const all = ls.all();
                const id = slotLayoutId(slot, ls.snapshots, all.map((l) => l.id));
                if (!id) return;
                e.preventDefault();
                useUiStore.getState().setStage(false);
                ls.setActive(id);
                const name = all.find((l) => l.id === id)?.name ?? id;
                useAnnounce.getState().say(translate(locale, "shell.snapshot", { slot, name }));
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyS") {
                e.preventDefault();
                const ui = useUiStore.getState();
                ui.setStage(!ui.stage);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [locale]);

    useEffect(() => {
        let cancelled = false;
        let off: (() => void) | undefined;
        void subscribeBleMidi(
            () => {},
            (name) => applyControllerLayout(name, locale),
        ).then((u) => {
            if (cancelled) u();
            else off = u;
        });
        const onMidi = (e: Event) => {
            const name = (e as CustomEvent<string>).detail;
            if (typeof name === "string") applyControllerLayout(name, locale);
        };
        window.addEventListener("mixai:midi-connected", onMidi);
        return () => {
            cancelled = true;
            off?.();
            window.removeEventListener("mixai:midi-connected", onMidi);
        };
    }, [locale]);
}
