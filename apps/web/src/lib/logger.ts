/**
 * Tiny structured logger.
 *
 * Goal: replace ad-hoc `console.log("...", value)` calls scattered around
 * server code with a single function that always emits one JSON line per
 * event. JSON-per-line is what every cloud log sink (Cloud Run, Vercel,
 * Datadog, Loki) consumes natively, and it lets us add fields later
 * without breaking parsers.
 *
 * - In development we pretty-print so it's still readable in the terminal.
 * - In production we emit `JSON.stringify({ level, msg, time, ...fields })`.
 *
 * For *exceptional* paths we also forward to Sentry via a thin shim so
 * Sentry stays optional — anyone running self-hosted without a SENTRY_DSN
 * gets full local logs and zero outbound traffic.
 */

import { captureException } from "./sentry";

type Level = "debug" | "info" | "warn" | "error";

type Fields = Record<string, unknown>;

const isProd = process.env.NODE_ENV === "production";

// Field names whose values must never appear in logs. Match is exact
// (case-insensitive) on the leaf key — sufficient because callers pass
// flat objects; covers the keys we actually use across the codebase.
const REDACTED_KEYS = new Set([
    "token", "tokens", "tokenhash", "tokenencrypted",
    "secret", "secrets", "apikey", "api_key", "apitoken",
    "password", "passphrase",
    "cookie", "cookies", "authorization", "auth",
    "stripesecret", "stripesecretkey", "stripewebhooksecret",
    "authsecret", "mmosecretkey",
    "clientsecret", "refreshtoken", "accesstoken", "idtoken",
    "sessiontoken",
]);

function redact(value: unknown, depth = 0): unknown {
    if (depth > 4 || value == null) return value;
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
    if (typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (REDACTED_KEYS.has(k.toLowerCase())) {
                out[k] = typeof v === "string" && v.length > 0 ? "[redacted]" : v;
            } else {
                out[k] = redact(v, depth + 1);
            }
        }
        return out;
    }
    return value;
}

function emit(level: Level, msg: string, fields?: Fields, err?: unknown) {
    const time = new Date().toISOString();
    const base: Record<string, unknown> = { time, level, msg };
    if (fields) Object.assign(base, redact(fields) as Record<string, unknown>);
    if (err) {
        base.error = err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err);
    }

    if (isProd) {
        // One JSON line per event — log sinks parse `severity` automatically
        // when present, so dual-name it.
        base.severity = level.toUpperCase();
        const out = level === "error" || level === "warn" ? console.error : console.log;
        out(JSON.stringify(base));
    } else {
        const tag = `[${level.toUpperCase()}]`;
        const extra = fields && Object.keys(fields).length > 0 ? fields : "";
        const fn = level === "error" || level === "warn" ? console.error : console.log;
        if (err) fn(tag, msg, extra, err);
        else fn(tag, msg, extra);
    }

    if (level === "error" && err) captureException(err, { msg, ...fields });
}

export const log = {
    debug: (msg: string, fields?: Fields) => emit("debug", msg, fields),
    info: (msg: string, fields?: Fields) => emit("info", msg, fields),
    warn: (msg: string, fields?: Fields, err?: unknown) => emit("warn", msg, fields, err),
    error: (msg: string, err: unknown, fields?: Fields) => emit("error", msg, fields, err),
};
