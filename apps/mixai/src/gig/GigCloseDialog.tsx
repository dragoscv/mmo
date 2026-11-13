/**
 * "Close MixAI Decks?": asked inside the app when the main window is about to close while the
 * gig lock is on (title bar X, Alt+F4, taskbar: the shell holds the request back and sends
 * `gig://close-request`; the title bar button asks through bridge/window.ts). Mounted by
 * App.tsx; pop-out windows never ask.
 *
 * The focus starts on the safe choice ("Keep playing"), Esc keeps playing too. Whether a
 * recording runs is asked of the ENGINE when the question opens (the page's own flag is not
 * re-read after a page reload), and the text follows that answer. "Close anyway" stops the
 * recording through the engine, waits until the file is complete, and then closes for real.
 * If that goes wrong the question stays, with a sentence saying what happened: the DJ is never
 * left with a window that silently did not close. The lock itself stays on: the next start
 * comes back locked, like after a crash.
 *
 * Bare arrows are the app's crossfader shortcuts (left / right = hard to A / B): the dialog
 * uses them up, so moving between its two buttons with the arrows never cuts the mix.
 */
import { useEffect, useState } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, Button } from "@mmo/ui";
import { useT, type MessageKey } from "@/i18n";
import { consumeBareArrows } from "@/remote/remote-core";
import { closeForReal, engineRecording } from "./gig-runtime";
import { useGigStore } from "./gig-store";

/** What went wrong with "Close anyway" (the sentence shown in the dialog). */
type Problem = "stopFailed" | "closeFailed" | "closeFailedRec";
const PROBLEM_KEY: Record<Problem, MessageKey> = {
    stopFailed: "gig.close.stopFailed",
    closeFailed: "gig.close.closeFailed",
    closeFailedRec: "gig.close.closeFailedRec",
};

export function GigCloseDialog() {
    const t = useT();
    const ask = useGigStore((s) => s.closeAsk);
    // The engine's answer; null until it came (the text then promises nothing about a recording).
    const [recording, setRecording] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<Problem | null>(null);

    useEffect(() => {
        if (!ask) {
            setProblem(null);
            setBusy(false);
            return;
        }
        let live = true;
        setRecording(null);
        void engineRecording().then((on) => {
            if (live) setRecording(on);
        });
        return () => {
            live = false;
        };
    }, [ask]);

    const onClose = () => {
        if (busy) return;
        setBusy(true);
        setProblem(null);
        const wasRecording = recording === true;
        void closeForReal().then((result) => {
            // "closed": the window is going away; nothing left to show.
            if (result === "closed") return;
            setBusy(false);
            if (result === "stopFailed") return setProblem("stopFailed");
            // The stop worked and the close did not: the recording is safe, and the text says so.
            if (wasRecording) setRecording(false);
            setProblem(wasRecording ? "closeFailedRec" : "closeFailed");
        });
    };

    return (
        <AlertDialog open={ask} onOpenChange={(open) => useGigStore.getState().setCloseAsk(open)}>
            {/* The safe choice gets the focus, not the first button in the row. */}
            <AlertDialogContent
                onKeyDown={(e) => {
                    consumeBareArrows(e);
                }}
                size="sm"
                data-gig-close=""
                data-recording={recording === null ? "unknown" : String(recording)}
                initialFocus={() => document.querySelector<HTMLElement>("[data-gig-close-keep]")}
            >
                <AlertDialogHeader>
                    <AlertDialogTitle>{t("gig.close.title")}</AlertDialogTitle>
                    <AlertDialogDescription>{recording ? t("gig.close.bodyRec") : t("gig.close.body")}</AlertDialogDescription>
                    {problem && (
                        <p role="alert" className="gg-close-problem" data-gig-close-problem={problem}>
                            {t(PROBLEM_KEY[problem])}
                        </p>
                    )}
                </AlertDialogHeader>
                <AlertDialogFooter>
                    {/* A plain button, not the dialog's own closing "action": the question stays open until the window is really closing. */}
                    <Button variant="destructive" data-gig-close-anyway="" aria-disabled={busy || undefined} onClick={onClose}>
                        {busy ? t("gig.close.working") : t("gig.close.close")}
                    </Button>
                    <AlertDialogCancel variant="default" data-gig-close-keep="">
                        {t("gig.close.keep")}
                    </AlertDialogCancel>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
