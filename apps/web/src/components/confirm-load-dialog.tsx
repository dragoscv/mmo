"use client";

import { useState, useCallback, useEffect } from "react";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { usePersonalization } from "@/hooks/use-personalization";
import { AlertTriangle } from "lucide-react";
import type { DeckSide } from "@/lib/mixer-engine";
import type { Track } from "@/db/schema";

interface PendingLoad {
    deck: DeckSide;
    track: Track;
}

interface ConfirmLoadDialogState {
    open: boolean;
    pending: PendingLoad | null;
}

let resolveConfirm: ((confirmed: boolean) => void) | null = null;
let dialogSetter: ((state: ConfirmLoadDialogState) => void) | null = null;

/**
 * Show the confirm-load dialog if a deck is playing.
 * Returns true if load should proceed, false if cancelled.
 */
export function requestConfirmLoad(deck: DeckSide, track: Track): Promise<boolean> {
    return new Promise((resolve) => {
        resolveConfirm = resolve;
        dialogSetter?.({ open: true, pending: { deck, track } });
    });
}

export function ConfirmLoadDialog() {
    const personalization = usePersonalization();
    const [state, setState] = useState<ConfirmLoadDialogState>({
        open: false,
        pending: null,
    });
    const [dontAskAgain, setDontAskAgain] = useState(false);

    // Register the setter so requestConfirmLoad can open the dialog.
    // Module-scope reassignment runs in a layout effect (not during
    // render) so React Compiler / StrictMode double-render don't see a
    // mid-render side effect, and the cleanup nulls the slot when the
    // singleton dialog unmounts.
    useEffect(() => {
        dialogSetter = setState;
        return () => { dialogSetter = null; };
    }, []);

    const handleConfirm = useCallback(() => {
        if (dontAskAgain) {
            personalization.update({ confirmLoadOnPlayingDeck: false });
        }
        setState({ open: false, pending: null });
        setDontAskAgain(false);
        resolveConfirm?.(true);
        resolveConfirm = null;
    }, [dontAskAgain, personalization]);

    const handleCancel = useCallback(() => {
        setState({ open: false, pending: null });
        setDontAskAgain(false);
        resolveConfirm?.(false);
        resolveConfirm = null;
    }, []);

    return (
        <AlertDialog open={state.open} onOpenChange={(open) => { if (!open) handleCancel(); }}>
            <AlertDialogContent className="bg-zinc-950 border-white/10 max-w-sm z-[90]">
                <AlertDialogHeader>
                    <div className="flex items-center gap-2">
                        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-amber-500/15">
                            <AlertTriangle className="h-4 w-4 text-amber-400" />
                        </div>
                        <AlertDialogTitle className="text-sm font-semibold text-white/90">
                            Deck {state.pending?.deck} is playing
                        </AlertDialogTitle>
                    </div>
                    <AlertDialogDescription className="text-xs text-white/50 mt-1">
                        Loading a new track will stop the current playback on Deck {state.pending?.deck}.
                        Are you sure you want to replace{" "}
                        <span className="text-white/70">the current track</span> with{" "}
                        <span className="text-white/70">{state.pending?.track.title || state.pending?.track.filename}</span>?
                    </AlertDialogDescription>
                </AlertDialogHeader>

                <label className="flex items-center gap-2 cursor-pointer select-none group">
                    <div className="relative">
                        <input
                            type="checkbox"
                            checked={dontAskAgain}
                            onChange={(e) => setDontAskAgain(e.target.checked)}
                            className="sr-only peer"
                        />
                        <div className="w-4 h-4 rounded border border-white/20 bg-white/5 peer-checked:bg-amber-500/30 peer-checked:border-amber-500/50 transition-colors flex items-center justify-center">
                            {dontAskAgain && (
                                <svg className="w-3 h-3 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                            )}
                        </div>
                    </div>
                    <span className="text-[11px] text-white/40 group-hover:text-white/60 transition-colors">
                        Don&apos;t ask again
                    </span>
                </label>

                <AlertDialogFooter>
                    <AlertDialogCancel
                        onClick={handleCancel}
                        className="text-xs bg-white/5 border-white/10 text-white/60 hover:bg-white/10 hover:text-white/80 cursor-pointer"
                    >
                        Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                        onClick={handleConfirm}
                        className="text-xs bg-amber-500/20 border border-amber-500/30 text-amber-300 hover:bg-amber-500/30 cursor-pointer"
                    >
                        Load anyway
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
