/**
 * Browser-side instrumentation. Mirrors `instrumentation.ts` but runs
 * in the client bundle. Same opt-in story: no DSN ⇒ no init ⇒ no
 * network. The dynamic import keeps `@sentry/nextjs` out of the
 * default client bundle.
 */

if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_SENTRY_DSN) {
    const importPath = "@sentry/nextjs" as string;
    void import(/* webpackIgnore: true */ importPath)
        .then((mod: {
            init?: (opts: Record<string, unknown>) => void;
            feedbackIntegration?: (opts: Record<string, unknown>) => unknown;
        } | null) => {
            const integrations: unknown[] = [];
            // User feedback widget — opt-in via NEXT_PUBLIC_SENTRY_FEEDBACK=1.
            // Mounts a floating "Report a problem" button that captures
            // a screenshot + free-form description and ships it to
            // Sentry alongside the current breadcrumb trail. Lazy so
            // it never costs anything when disabled.
            if (process.env.NEXT_PUBLIC_SENTRY_FEEDBACK === "1" && mod?.feedbackIntegration) {
                integrations.push(
                    mod.feedbackIntegration({
                        colorScheme: "dark",
                        showBranding: false,
                        autoInject: true,
                        buttonLabel: "Raporteaza o problema",
                        submitButtonLabel: "Trimite",
                        cancelButtonLabel: "Anuleaza",
                        formTitle: "Trimite-ne feedback",
                        messagePlaceholder: "Ce s-a intamplat?",
                        successMessageText: "Multumim! Am primit raportul.",
                    }),
                );
            }
            mod?.init?.({
                dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
                environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
                release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
                tracesSampleRate: 0.1,
                replaysSessionSampleRate: 0.0,
                replaysOnErrorSampleRate: 1.0,
                integrations,
            });
        })
        .catch(() => {
            // Sentry not installed — silent no-op.
        });
}
