/**
 * Is a mixer panel on screen in this window? The master level control and the master meter
 * must exist in exactly one place: the mixer's master column when there is a mixer, else the
 * crossfader panel (layouts without a mixer, or a mixer popped out into its own window).
 */
import { useEffect } from "react";
import { create } from "zustand";

const useMixerPresence = create<{ count: number }>(() => ({ count: 0 }));

/** Called by the mixer panel: counts itself in while it is mounted. */
export function useAnnounceMixer(): void {
    useEffect(() => {
        useMixerPresence.setState((s) => ({ count: s.count + 1 }));
        return () => useMixerPresence.setState((s) => ({ count: Math.max(0, s.count - 1) }));
    }, []);
}

/** True while at least one mixer panel is mounted in this window. */
export function useMixerShown(): boolean {
    return useMixerPresence((s) => s.count > 0);
}
