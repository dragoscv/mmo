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
import { useLayoutStore } from "@/layout/layout-store";
import { useUiStore } from "@/state/ui-store";
import { translate, useLocale } from "@/i18n";
import { create } from "zustand";

interface Announce {
    text: string;
    at: number;
    say: (text: string) => void;
}

export const useAnnounce = create<Announce>((set) => ({ text: "", at: 0, say: (text) => set({ text, at: Date.now() }) }));

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

export function applyControllerLayout(device: string, locale: "en" | "ro"): void {
    const ls = useLayoutStore.getState();
    const id = controllerLayoutId(device, ls.controllerLayouts);
    if (!id) return;
    const l = ls.all().find((x) => x.id === id);
    if (!l) return;
    ls.setActive(id);
    useAnnounce.getState().say(translate(locale, "shell.controllerLayout", { device, name: l.name }));
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
