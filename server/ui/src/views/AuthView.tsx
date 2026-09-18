import { useState } from "react";
import { Button, Card, CardContent, EmptyState, useToast } from "@mmo/ui";
import { Loader2, Music2 } from "lucide-react";
import { useT } from "../i18n";
import { errorMessage, ipc } from "../lib/ipc";

const WEB_APP_URL = "https://mixai.ro";

function GoogleMark() {
    return (
        <svg width="18" height="18" viewBox="0 0 48 48" className="shrink-0" aria-hidden>
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
        </svg>
    );
}

export function AuthView({
    onAuthenticated,
    invalidatedReason,
}: {
    onAuthenticated: () => Promise<unknown>;
    invalidatedReason: string | null;
}) {
    const t = useT();
    const toast = useToast();
    const [waiting, setWaiting] = useState(false);
    const [cancelling, setCancelling] = useState(false);

    /**
     * Ported from the legacy `handleGoogleSignIn`: the button becomes a
     * "waiting / click to cancel" control while the OAuth round-trip runs in
     * the user's browser. `cancelAuth` resolves the pending
     * `openAuthInBrowser` with `null`, which restores the button.
     */
    async function signIn() {
        if (waiting) {
            setCancelling(true);
            try {
                await ipc().cancelAuth();
            } catch {
                /* ignore */
            }
            return;
        }
        setWaiting(true);
        try {
            const result = await ipc().openAuthInBrowser(WEB_APP_URL);
            if (result) await onAuthenticated();
        } catch (err) {
            toast.add({ type: "error", title: t("auth.failed"), description: errorMessage(err) });
        } finally {
            setWaiting(false);
            setCancelling(false);
        }
    }

    return (
        <div className="flex h-full items-center justify-center p-6">
            <Card className="w-full max-w-sm">
                <CardContent className="pt-6">
                    <EmptyState
                        variant="inline"
                        icon={
                            <span className="flex size-14 items-center justify-center rounded-2xl bg-brand-gradient text-white shadow-lg">
                                <Music2 className="size-7" aria-hidden />
                            </span>
                        }
                        title={t("auth.title")}
                        description={t("auth.subtitle", { host: "mixai.ro" })}
                        actions={
                            <div className="flex w-full flex-col items-stretch gap-3">
                                {invalidatedReason && (
                                    <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
                                        {t("auth.invalidated")}
                                    </p>
                                )}
                                <Button variant="outline" size="lg" className="w-full" onClick={signIn} disabled={cancelling} aria-busy={waiting}>
                                    {waiting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <GoogleMark />}
                                    {waiting ? t("auth.waiting") : t("auth.google")}
                                </Button>
                                <p className="text-center text-[11px] text-muted-foreground">{t("auth.sameAccount")}</p>
                            </div>
                        }
                    />
                </CardContent>
            </Card>
        </div>
    );
}
