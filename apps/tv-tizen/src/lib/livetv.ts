/**
 * Live TV client (`/livetv/*`, WP16-12..16). `streamUrl(id)` = `/livetv/stream/{id}?proxy=1&t=` — the server
 * pipes the bytes and REWRITES HLS playlists so every variant/segment/key goes through signed
 * `/livetv/proxy/...` URLs (server ≥ 3.7.0), so hls.js / native HLS work from file:// without CORS issues.
 */
import type { ServerConfig } from "./config";
import { ServerHttp, enc } from "./http";
import type {
    LiveTvChannel, LiveTvNowNext, LiveTvProgramme, LiveTvRecordInput, LiveTvRecording, LiveTvRule, LiveTvRuleInput,
    LiveTvSource, LiveTvSourceInput,
} from "./media-types";
import type { ProfilesClient } from "./profiles";

export interface ChannelFilter {
    group?: string;
    favourites?: boolean;
    hidden?: boolean;
    source?: string;
}

export class LiveTvClient {
    private readonly http: ServerHttp;

    constructor(cfg: ServerConfig, private readonly profiles: ProfilesClient | null = null) {
        this.http = new ServerHttp(cfg);
    }

    private profileId(): string { return this.profiles?.profileId ?? "default"; }

    // Sources
    async sources(): Promise<LiveTvSource[]> {
        const r = await this.http.get<{ sources: LiveTvSource[] }>("/livetv/sources", { allow404: true });
        return r?.sources ?? [];
    }
    createSource(input: LiveTvSourceInput): Promise<LiveTvSource | null> { return this.http.post<LiveTvSource>("/livetv/sources", input); }
    updateSource(id: string, input: LiveTvSourceInput): Promise<LiveTvSource | null> { return this.http.patch<LiveTvSource>(`/livetv/sources/${enc(id)}`, input); }
    deleteSource(id: string): Promise<unknown> { return this.http.del(`/livetv/sources/${enc(id)}`); }
    testSource(id: string): Promise<{ ok: boolean; channelCount: number; error?: string | null } | null> {
        return this.http.post(`/livetv/sources/${enc(id)}/test`, {}, { timeoutMs: 30_000 });
    }
    refreshSource(id: string): Promise<unknown> { return this.http.post(`/livetv/sources/${enc(id)}/refresh`, {}, { timeoutMs: 60_000 }); }

    // Channels
    async channels(f: ChannelFilter = {}): Promise<LiveTvChannel[]> {
        const q = new URLSearchParams({ profile: this.profileId() });
        if (f.group) q.set("group", f.group);
        if (f.favourites) q.set("favourites", "1");
        if (f.hidden) q.set("hidden", "1");
        if (f.source) q.set("source", f.source);
        const r = await this.http.get<{ channels: LiveTvChannel[] }>(`/livetv/channels?${q.toString()}`, { allow404: true });
        return r?.channels ?? [];
    }
    updateChannel(id: string, patch: { hidden?: boolean; sort?: number | null; number?: string | null }): Promise<LiveTvChannel | null> {
        return this.http.patch<LiveTvChannel>(`/livetv/channels/${enc(id)}`, patch);
    }
    setFavourite(id: string, fav: boolean): Promise<{ ok?: boolean; favourite?: boolean } | null> {
        const p = `/livetv/channels/${enc(id)}/favourite?profile=${enc(this.profileId())}`;
        return fav ? this.http.put(p) : this.http.del(p);
    }
    async groups(): Promise<{ name: string; count: number }[]> {
        const r = await this.http.get<{ groups: { name: string; count: number }[] }>("/livetv/groups", { allow404: true });
        return r?.groups ?? [];
    }

    // Guide
    async guide(opts: { from?: number; to?: number; channels?: string[] } = {}): Promise<{ from: number; to: number; programmes: LiveTvProgramme[] }> {
        const q = new URLSearchParams();
        if (opts.from) q.set("from", String(opts.from));
        if (opts.to) q.set("to", String(opts.to));
        if (opts.channels?.length) q.set("channels", opts.channels.join(","));
        const r = await this.http.get<{ from: number; to: number; programmes: LiveTvProgramme[] }>(`/livetv/guide?${q.toString()}`, { allow404: true });
        return r ?? { from: opts.from ?? 0, to: opts.to ?? 0, programmes: [] };
    }
    async now(channels?: string[]): Promise<{ now: number; channels: LiveTvNowNext[] }> {
        const q = channels?.length ? `?channels=${enc(channels.join(","))}` : "";
        const r = await this.http.get<{ now: number; channels: LiveTvNowNext[] }>(`/livetv/now${q}`, { allow404: true });
        return r ?? { now: Date.now(), channels: [] };
    }

    // DVR
    async recordings(): Promise<LiveTvRecording[]> {
        const r = await this.http.get<{ recordings: LiveTvRecording[] }>("/livetv/recordings", { allow404: true });
        return r?.recordings ?? [];
    }
    record(input: LiveTvRecordInput): Promise<LiveTvRecording | null> { return this.http.post<LiveTvRecording>("/livetv/recordings", input); }
    deleteRecording(id: string): Promise<{ ok?: boolean; status?: string; deleted?: boolean } | null> { return this.http.del(`/livetv/recordings/${enc(id)}`); }
    async rules(): Promise<LiveTvRule[]> {
        const r = await this.http.get<{ rules: LiveTvRule[] }>("/livetv/rules", { allow404: true });
        return r?.rules ?? [];
    }
    createRule(input: LiveTvRuleInput): Promise<LiveTvRule | null> { return this.http.post<LiveTvRule>("/livetv/rules", input); }
    deleteRule(id: string): Promise<unknown> { return this.http.del(`/livetv/rules/${enc(id)}`); }

    // Media URLs (no headers possible → `t=`)
    /** Proxied stream (HLS rewritten by the server; MPEG-TS piped). */
    streamUrl(channelId: string): string {
        return this.http.url(`/livetv/stream/${enc(channelId)}?proxy=1&${this.http.authQuery()}`);
    }
    /** Catch-up (timeshift) for a past programme: start epoch ms, duration seconds. */
    catchupUrl(channelId: string, startMs: number, durationSec: number): string {
        return this.http.url(`/livetv/catchup/${enc(channelId)}?start=${Math.floor(startMs)}&duration=${Math.floor(durationSec)}&${this.http.authQuery()}`);
    }
    /** Channel logos are absolute upstream URLs; returned as-is (null when missing). */
    logoUrl(ch: Pick<LiveTvChannel, "logo">): string | null {
        return ch.logo && /^https?:\/\//i.test(ch.logo) ? ch.logo : null;
    }
}
