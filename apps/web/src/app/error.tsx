"use client";

/**
 * Segment-level error boundary. Catches render/effect errors thrown
 * inside the root layout's children and forwards them to the Sentry
 * shim (no-op when SENTRY_DSN is unset). The fallback stays inside
 * the layout, so the header / nav / theme are preserved.
 */

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function RouteError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        void import("@/lib/sentry").then(({ captureException }) => {
            captureException(error, { digest: error.digest });
        });
    }, [error]);

    return (
        <div className="container mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 px-4 py-12 text-center">
            <AlertTriangle className="h-10 w-10 text-amber-500" aria-hidden />
            <h1 className="text-xl font-semibold">Something went wrong</h1>
            <p className="text-sm text-muted-foreground">
                The page hit an unexpected error. You can try again — if it keeps
                happening, the issue has been reported.
            </p>
            {error.digest ? (
                <p className="font-mono text-xs text-muted-foreground">ref: {error.digest}</p>
            ) : null}
            <Button onClick={reset} variant="default">
                <RefreshCw className="mr-2 h-4 w-4" /> Try again
            </Button>
        </div>
    );
}
