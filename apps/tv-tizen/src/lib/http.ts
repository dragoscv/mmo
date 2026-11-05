/**
 * Shared JSON transport for the MMO Server routes (profiles, music, live TV, hub HTTP).
 * Sends `x-device-token` (+ `x-user-id`) and whatever `extraHeaders()` returns — the profile token
 * (`x-profile-token`) for profile-scoped routes. 10 s timeout by default.
 */
import { ApiError } from "./api";
import type { ServerConfig } from "./config";

export interface RequestOpts {
    /** Return `null` on 404 instead of throwing. */
    allow404?: boolean;
    timeoutMs?: number;
    headers?: Record<string, string>;
}

export class ServerHttp {
    constructor(readonly cfg: ServerConfig, private readonly extraHeaders: () => Record<string, string> = () => ({})) {}

    headers(json = false): Record<string, string> {
        const h: Record<string, string> = { "x-device-token": this.cfg.token, ...this.extraHeaders() };
        if (this.cfg.userId) h["x-user-id"] = this.cfg.userId;
        if (json) h["content-type"] = "application/json";
        return h;
    }

    /** `t=&u=` for URLs consumed by media elements / WebSocket (no custom headers possible). */
    authQuery(): string {
        const parts = [`t=${encodeURIComponent(this.cfg.token)}`];
        if (this.cfg.userId) parts.push(`u=${encodeURIComponent(this.cfg.userId)}`);
        return parts.join("&");
    }

    url(path: string): string {
        return this.cfg.baseUrl + path;
    }

    async request<T>(method: string, path: string, body?: unknown, opts: RequestOpts = {}): Promise<T | null> {
        const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000) : null;
        try {
            const res = await fetch(this.url(path), {
                method,
                headers: { ...this.headers(body !== undefined), ...(opts.headers ?? {}) },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: ctrl?.signal,
            });
            if (res.status === 404 && opts.allow404) return null;
            if (res.status === 204) return null;
            const text = await res.text();
            let parsed: unknown = null;
            try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
            if (!res.ok) {
                const msg = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
                    ? (parsed as { error: string }).error : `${res.status} ${res.statusText}`;
                throw new ApiError(msg, res.status, parsed);
            }
            return parsed as T;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    get<T>(path: string, opts?: RequestOpts): Promise<T | null> { return this.request<T>("GET", path, undefined, opts); }
    post<T>(path: string, body?: unknown, opts?: RequestOpts): Promise<T | null> { return this.request<T>("POST", path, body ?? {}, opts); }
    put<T>(path: string, body?: unknown, opts?: RequestOpts): Promise<T | null> { return this.request<T>("PUT", path, body ?? {}, opts); }
    patch<T>(path: string, body: unknown, opts?: RequestOpts): Promise<T | null> { return this.request<T>("PATCH", path, body, opts); }
    del<T>(path: string, opts?: RequestOpts): Promise<T | null> { return this.request<T>("DELETE", path, undefined, opts); }

    /** Like `get` but throws when the server answered 404/empty (for routes that must exist). */
    async must<T>(p: Promise<T | null>): Promise<T> {
        const v = await p;
        if (v === null) throw new ApiError("empty response", 0);
        return v;
    }
}

export const enc = encodeURIComponent;
