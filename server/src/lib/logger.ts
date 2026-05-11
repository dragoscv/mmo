/**
 * Companion-side structured logger.
 *
 * Mirrors the web app's `app/src/lib/logger.ts` shape so call sites read
 * the same way on both sides. Always writes to `console.*` so existing
 * Electron stdout/stderr capture (and the in-app log viewer) keeps
 * working unchanged. JSON-per-line in production, pretty in dev.
 *
 * Sentry forwarding is **strictly opt-in**: it requires BOTH
 *   1. `SENTRY_DSN` set in the build environment (so the dist actually
 *      has a destination), and
 *   2. `telemetryEnabled = true` in the user's persistent settings
 *      (so the user has consented).
 *
 * Without both, the logger never imports `@sentry/electron` and never
 * makes a network call — important for a self-hosted desktop app.
 */

type Level = "debug" | "info" | "warn" | "error";

type Fields = Record<string, unknown>;

const isProd = process.env.NODE_ENV === "production";

interface SentryLike {
    init(opts: Record<string, unknown>): void;
    captureException(err: unknown, hint?: { extra?: Record<string, unknown> }): void;
}

let _sentry: SentryLike | null | undefined;
let _sentryAttempted = false;
let _telemetryEnabled = false;

/** Called by main.ts on boot AFTER reading the user's persistent
 *  settings; keeps logger.ts free of any electron-store dependency. */
export function setTelemetryEnabled(enabled: boolean): void {
    _telemetryEnabled = enabled;
    if (enabled) void loadSentry();
}

async function loadSentry(): Promise<SentryLike | null> {
    if (_sentryAttempted) return _sentry ?? null;
    _sentryAttempted = true;
    if (!process.env.SENTRY_DSN) {
        _sentry = null;
        return null;
    }
    try {
        const importPath = "@sentry/electron/main" as string;
        const mod = (await import(/* webpackIgnore: true */ importPath).catch(() => null)) as
            | SentryLike | null;
        if (mod?.init) {
            mod.init({
                dsn: process.env.SENTRY_DSN,
                environment: process.env.NODE_ENV,
                release: process.env.SENTRY_RELEASE,
                // Companion is desktop-only; no PII unless explicitly enabled.
                sendDefaultPii: process.env.SENTRY_SEND_PII === "1",
            });
        }
        _sentry = mod ?? null;
        return _sentry;
    } catch {
        _sentry = null;
        return null;
    }
}

function emit(level: Level, msg: string, fields?: Fields, err?: unknown) {
    const time = new Date().toISOString();
    const base: Record<string, unknown> = { time, level, msg };
    if (fields) Object.assign(base, fields);
    if (err) {
        base.error = err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack }
            : String(err);
    }

    const fn = level === "error" || level === "warn" ? console.error : console.log;
    if (isProd) {
        base.severity = level.toUpperCase();
        fn(JSON.stringify(base));
    } else {
        const tag = `[${level.toUpperCase()}]`;
        const extra = fields && Object.keys(fields).length > 0 ? fields : "";
        if (err) fn(tag, msg, extra, err);
        else fn(tag, msg, extra);
    }

    // Forward errors to Sentry only when both gates are open. The
    // captureException is fire-and-forget so the logger stays sync.
    if (level === "error" && err && _telemetryEnabled) {
        void loadSentry().then((sentry) => {
            try { sentry?.captureException(err, fields ? { extra: fields } : undefined); }
            catch { /* never let telemetry break the caller */ }
        });
    }
}

export const log = {
    debug: (msg: string, fields?: Fields) => emit("debug", msg, fields),
    info: (msg: string, fields?: Fields) => emit("info", msg, fields),
    warn: (msg: string, fields?: Fields, err?: unknown) => emit("warn", msg, fields, err),
    error: (msg: string, err: unknown, fields?: Fields) => emit("error", msg, fields, err),
};
