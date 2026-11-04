/**
 * Xtream Codes `player_api.php` client (user-supplied credentials only).
 *
 * Every request has a 10 s timeout; error messages are redacted so the
 * password (and username) never reach logs or HTTP responses.
 */

import { defaultFetch, errorMessage, fetchJson, num, redactText, str, type FetchLike } from "./util";

export interface XtreamCredentials { host: string; username: string; password: string }

export interface XtreamUserInfo {
    username: string | null;
    status: string | null;
    auth: boolean;
    expDate: number | null;
    maxConnections: number | null;
    activeConnections: number | null;
    isTrial: boolean;
}

export interface XtreamServerInfo { url: string | null; port: string | null; httpsPort: string | null; protocol: string | null; timezone: string | null }

export interface XtreamCategory { id: string; name: string }

export interface XtreamLiveStream {
    streamId: number;
    num: number | null;
    name: string;
    icon: string | null;
    epgChannelId: string | null;
    categoryId: string | null;
    tvArchive: boolean;
    tvArchiveDuration: number;
}

export interface XtreamEpgEntry { title: string; description: string; start: number; stop: number }

export class XtreamError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "XtreamError";
    }
}

/** Normalise `example.com:8080`, `http://x/`, `http://x/player_api.php?...` to `http://x:8080`. */
export function normaliseHost(host: string): string {
    let h = host.trim();
    if (!/^https?:\/\//i.test(h)) h = `http://${h}`;
    try {
        const u = new URL(h);
        const path = u.pathname.replace(/\/(player_api\.php|get\.php|xmltv\.php)$/i, "").replace(/\/+$/, "");
        return `${u.protocol}//${u.host}${path}`;
    } catch {
        return h.replace(/\/+$/, "");
    }
}

/** Decode base64 EPG text (UTF-8); falls back to the raw value if it is not base64. */
export function decodeBase64Text(v: unknown): string {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) return "";
    if (!/^[A-Za-z0-9+/=\r\n_-]+$/.test(s) || s.length % 4 === 1) return s;
    try {
        const out = Buffer.from(s, "base64").toString("utf8");
        return out.includes("\ufffd") ? s : out;
    } catch {
        return s;
    }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD:HH-MM` in UTC (providers differ; UTC is the common default — override via tzOffsetMin). */
export function formatTimeshiftStart(ms: number, tzOffsetMin = 0): string {
    const d = new Date(ms + tzOffsetMin * 60_000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}:${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`;
}

export class XtreamClient {
    readonly host: string;
    private readonly fetchImpl: FetchLike;
    private readonly timeoutMs: number;

    constructor(private readonly creds: XtreamCredentials, opts: { fetch?: FetchLike; timeoutMs?: number } = {}) {
        this.host = normaliseHost(creds.host);
        this.fetchImpl = opts.fetch ?? defaultFetch;
        this.timeoutMs = opts.timeoutMs ?? 10_000;
    }

    private q(): string {
        return `username=${encodeURIComponent(this.creds.username)}&password=${encodeURIComponent(this.creds.password)}`;
    }

    apiUrl(action?: string, extra: Record<string, string | number> = {}): string {
        let url = `${this.host}/player_api.php?${this.q()}`;
        if (action) url += `&action=${encodeURIComponent(action)}`;
        for (const [k, v] of Object.entries(extra)) url += `&${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`;
        return url;
    }

    private async call(action?: string, extra?: Record<string, string | number>): Promise<unknown> {
        try {
            return await fetchJson(this.fetchImpl, this.apiUrl(action, extra), this.timeoutMs);
        } catch (err) {
            throw new XtreamError(`Xtream ${action ?? "login"} failed: ${this.redact(errorMessage(err))}`);
        }
    }

    redact(text: string): string {
        return redactText(text, [this.creds.password, this.creds.username]);
    }

    async login(): Promise<{ user: XtreamUserInfo; server: XtreamServerInfo }> {
        const body = (await this.call()) as { user_info?: Record<string, unknown>; server_info?: Record<string, unknown> } | null;
        const u = body?.user_info;
        if (!u || typeof u !== "object") throw new XtreamError("Xtream login failed: unexpected response");
        const user: XtreamUserInfo = {
            username: str(u.username),
            status: str(u.status),
            auth: num(u.auth) === 1,
            expDate: num(u.exp_date),
            maxConnections: num(u.max_connections),
            activeConnections: num(u.active_cons),
            isTrial: num(u.is_trial) === 1,
        };
        if (!user.auth) throw new XtreamError("Xtream login rejected (check username/password)");
        const s = body?.server_info ?? {};
        return {
            user,
            server: { url: str(s.url), port: str(s.port), httpsPort: str(s.https_port), protocol: str(s.server_protocol), timezone: str(s.timezone) },
        };
    }

    async liveCategories(): Promise<XtreamCategory[]> {
        const body = await this.call("get_live_categories");
        if (!Array.isArray(body)) return [];
        return body
            .map((c: Record<string, unknown>) => ({ id: str(c.category_id) ?? "", name: str(c.category_name) ?? "" }))
            .filter((c) => c.id);
    }

    async liveStreams(categoryId?: string): Promise<XtreamLiveStream[]> {
        const body = await this.call("get_live_streams", categoryId ? { category_id: categoryId } : {});
        if (!Array.isArray(body)) return [];
        const out: XtreamLiveStream[] = [];
        for (const s of body as Array<Record<string, unknown>>) {
            const streamId = num(s.stream_id);
            if (streamId === null) continue;
            out.push({
                streamId,
                num: num(s.num),
                name: str(s.name)?.trim() || `Stream ${streamId}`,
                icon: str(s.stream_icon) || null,
                epgChannelId: str(s.epg_channel_id) || null,
                categoryId: str(s.category_id),
                tvArchive: num(s.tv_archive) === 1,
                tvArchiveDuration: num(s.tv_archive_duration) ?? 0,
            });
        }
        return out;
    }

    async shortEpg(streamId: number, limit = 4): Promise<XtreamEpgEntry[]> {
        const body = (await this.call("get_short_epg", { stream_id: streamId, limit })) as { epg_listings?: unknown } | null;
        const list = Array.isArray(body?.epg_listings) ? (body!.epg_listings as Array<Record<string, unknown>>) : [];
        const out: XtreamEpgEntry[] = [];
        for (const e of list) {
            const startTs = num(e.start_timestamp);
            const stopTs = num(e.stop_timestamp);
            const start = startTs !== null ? startTs * 1000 : Date.parse(String(e.start ?? "").replace(" ", "T") + "Z");
            const stop = stopTs !== null ? stopTs * 1000 : Date.parse(String(e.end ?? e.stop ?? "").replace(" ", "T") + "Z");
            if (!Number.isFinite(start) || !Number.isFinite(stop)) continue;
            out.push({ title: decodeBase64Text(e.title), description: decodeBase64Text(e.description), start, stop });
        }
        return out;
    }

    liveUrl(streamId: number, ext: "ts" | "m3u8" = "ts"): string {
        return `${this.host}/live/${encodeURIComponent(this.creds.username)}/${encodeURIComponent(this.creds.password)}/${streamId}.${ext}`;
    }

    timeshiftUrl(streamId: number, startMs: number, durationMin: number, tzOffsetMin = 0): string {
        const dur = Math.max(1, Math.round(durationMin));
        return `${this.host}/timeshift/${encodeURIComponent(this.creds.username)}/${encodeURIComponent(this.creds.password)}/${dur}/${formatTimeshiftStart(startMs, tzOffsetMin)}/${streamId}.ts`;
    }

    xmltvUrl(): string {
        return `${this.host}/xmltv.php?${this.q()}`;
    }
}
