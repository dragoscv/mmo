"use client";

/**
 * Segment-level error boundary. Catches render/effect errors thrown
 * inside the root layout's children and forwards them to the Sentry
 * shim (no-op when SENTRY_DSN is unset). The fallback stays inside
 * the layout, so the header / nav / theme are preserved.
 */

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { ErrorState } from "@mmo/ui";

export default function RouteError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    const t = useTranslations("common");
    useEffect(() => {
        void import("@/lib/sentry").then(({ captureException }) => {
            captureException(error, { digest: error.digest });
        });
    }, [error]);

    return (
        <ErrorState
            onRetry={reset}
            detail={
                <>
                    {t("errorDetail")}
                    {error.digest ? <span className="mt-2 block font-mono text-xs opacity-70">ref: {error.digest}</span> : null}
                </>
            }
        />
    );
}
