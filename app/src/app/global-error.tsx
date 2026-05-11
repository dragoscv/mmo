"use client";

/**
 * Root-level error boundary. Catches errors thrown in the root layout
 * itself (i.e. before the `error.tsx` boundary is mounted). Must render
 * its own <html> + <body>. Reports to the Sentry shim — no-op when
 * SENTRY_DSN is unset.
 */

import { useEffect } from "react";

export default function GlobalError({
    error,
}: {
    error: Error & { digest?: string };
}) {
    useEffect(() => {
        void import("@/lib/sentry").then(({ captureException }) => {
            captureException(error, { digest: error.digest, scope: "global" });
        });
    }, [error]);

    return (
        <html lang="en">
            <body
                style={{
                    fontFamily:
                        "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
                    background: "#0a0a0a",
                    color: "#fafafa",
                    margin: 0,
                    minHeight: "100vh",
                    display: "grid",
                    placeItems: "center",
                    padding: "2rem",
                }}
            >
                <main style={{ textAlign: "center", maxWidth: "32rem" }}>
                    <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>
                        Application crashed
                    </h1>
                    <p style={{ opacity: 0.7, marginBottom: "1.5rem" }}>
                        The app failed to render. Please reload the page. If the
                        problem persists, the issue has been reported automatically.
                    </p>
                    {error.digest ? (
                        <p
                            style={{
                                fontFamily: "ui-monospace, monospace",
                                fontSize: "0.75rem",
                                opacity: 0.5,
                                marginBottom: "1.5rem",
                            }}
                        >
                            ref: {error.digest}
                        </p>
                    ) : null}
                    <button
                        type="button"
                        onClick={() => window.location.reload()}
                        style={{
                            background: "#fafafa",
                            color: "#0a0a0a",
                            border: "none",
                            borderRadius: "0.375rem",
                            padding: "0.5rem 1rem",
                            cursor: "pointer",
                            fontSize: "0.875rem",
                            fontWeight: 500,
                        }}
                    >
                        Reload
                    </button>
                </main>
            </body>
        </html>
    );
}
