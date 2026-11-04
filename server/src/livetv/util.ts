/**
 * Shared helpers for the Live TV module: logger + fetch types, stable ids,
 * credential redaction (passwords never reach logs, errors or responses),
 * and fetch-with-timeout.
 */

import crypto from "node:crypto";

export interface LiveTvLogger {
    debug: (msg: string, fields?: Record<string, unknown>) => void;
    info: (msg: string, fields?: Record<string, unknown>) => void;
    warn: (msg: string, fields?: Record<string, unknown>, err?: unknown) => void;
    error: (msg: string, err: unknown, fields?: Record<string, unknown>) => void;
}

export interface FetchInit {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
}

/** Subset of WHATWG fetch; tests pass `new Response(...)` objects. */
export type FetchLike = (url: string, init?: FetchInit) => Promise<Response>;

export const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export const silentLogger: LiveTvLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** 16 hex chars of sha1 over the parts — stable across refreshes. */
export function stableId(...parts: string[]): string {
    return crypto.createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

export function newId(): string {
    return crypto.randomUUID();
}

const SECRET_QUERY = /([?&](?:password|pass|pwd|token|api_key|apikey|key)=)[^&#\s]*/gi;
const XTREAM_PATH = /\/(live|timeshift|movie|series)\/([^/\s]+)\/([^/\s]+)\//gi;
const USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;

/** Mask credentials inside a URL (query secrets, user:pass@, Xtream paths). */
export function redactUrl(url: string): string {
    return url
        .replace(USERINFO, "$1***@")
        .replace(SECRET_QUERY, "$1***")
        .replace(XTREAM_PATH, (_m, kind: string) => `/${kind}/***/***/`);
}

/** Mask known secrets plus anything URL-shaped in free text. */
export function redactText(text: string, secrets: Array<string | null | undefined> = []): string {
    let out = redactUrl(text);
    for (const s of secrets) {
        // Very short values would mangle ordinary words; URL-shaped credentials are already masked above.
        if (!s || s.length < 4) continue;
        out = out.split(s).join("***");
        const enc = encodeURIComponent(s);
        if (enc !== s) out = out.split(enc).join("***");
    }
    return out;
}

export function errorMessage(err: unknown): string {
    if (err instanceof Error) {
        const cause = (err as Error & { cause?: unknown }).cause;
        const c = cause instanceof Error ? `: ${cause.message}` : "";
        return `${err.message}${c}`;
    }
    return String(err);
}

export class HttpError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
        this.name = "HttpError";
    }
}

/** Fetch with an abort timeout covering headers AND the text body. */
export async function fetchText(fetchImpl: FetchLike, url: string, timeoutMs: number, headers?: Record<string, string>): Promise<string> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();
    try {
        const res = await fetchImpl(url, { signal: ac.signal, headers });
        if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`);
        return await res.text();
    } catch (err) {
        if (ac.signal.aborted) throw new Error(`timeout after ${timeoutMs} ms`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

export async function fetchJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
    const text = await fetchText(fetchImpl, url, timeoutMs, { accept: "application/json" });
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new Error("invalid JSON response");
    }
}

export const isHttpUrl = (s: string): boolean => /^https?:\/\//i.test(s);

export function str(v: unknown): string | null {
    if (typeof v === "string") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    return null;
}

export function num(v: unknown): number | null {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    return null;
}
