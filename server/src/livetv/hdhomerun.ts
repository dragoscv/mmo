/**
 * HDHomeRun network tuner: `discover.json` + `lineup.json`.
 * DRM channels are skipped (they cannot be recorded or played outside the
 * vendor app). TunerCount is the per-source concurrent stream limit.
 */

import { defaultFetch, errorMessage, fetchJson, num, str, type FetchLike } from "./util";

export interface HdhrDevice {
    friendlyName: string | null;
    modelNumber: string | null;
    deviceId: string | null;
    tunerCount: number;
    lineupUrl: string;
    baseUrl: string;
}

export interface HdhrChannel { guideNumber: string; guideName: string; url: string; hd: boolean; favorite: boolean }

export function hdhrBaseUrl(url: string): string {
    let h = url.trim();
    if (!/^https?:\/\//i.test(h)) h = `http://${h}`;
    return h.replace(/\/(discover|lineup)\.json.*$/i, "").replace(/\/+$/, "");
}

export class HdHomeRunClient {
    readonly baseUrl: string;
    private readonly fetchImpl: FetchLike;
    private readonly timeoutMs: number;

    constructor(url: string, opts: { fetch?: FetchLike; timeoutMs?: number } = {}) {
        this.baseUrl = hdhrBaseUrl(url);
        this.fetchImpl = opts.fetch ?? defaultFetch;
        this.timeoutMs = opts.timeoutMs ?? 10_000;
    }

    async discover(): Promise<HdhrDevice> {
        let body: Record<string, unknown>;
        try {
            body = (await fetchJson(this.fetchImpl, `${this.baseUrl}/discover.json`, this.timeoutMs)) as Record<string, unknown>;
        } catch (err) {
            throw new Error(`HDHomeRun discover failed: ${errorMessage(err)}`);
        }
        if (!body || typeof body !== "object") throw new Error("HDHomeRun discover failed: unexpected response");
        return {
            friendlyName: str(body.FriendlyName),
            modelNumber: str(body.ModelNumber),
            deviceId: str(body.DeviceID),
            tunerCount: Math.max(1, num(body.TunerCount) ?? 2),
            lineupUrl: str(body.LineupURL) ?? `${this.baseUrl}/lineup.json`,
            baseUrl: str(body.BaseURL) ?? this.baseUrl,
        };
    }

    async lineup(lineupUrl?: string): Promise<HdhrChannel[]> {
        let body: unknown;
        try {
            body = await fetchJson(this.fetchImpl, lineupUrl ?? `${this.baseUrl}/lineup.json`, this.timeoutMs);
        } catch (err) {
            throw new Error(`HDHomeRun lineup failed: ${errorMessage(err)}`);
        }
        if (!Array.isArray(body)) return [];
        const out: HdhrChannel[] = [];
        for (const c of body as Array<Record<string, unknown>>) {
            const tags = (str(c.Tags) ?? "").toLowerCase().split(",").map((t) => t.trim());
            if (tags.includes("drm") || num(c.DRM) === 1) continue;
            const url = str(c.URL);
            const guideNumber = str(c.GuideNumber);
            if (!url || !guideNumber) continue;
            out.push({ guideNumber, guideName: str(c.GuideName) ?? guideNumber, url, hd: num(c.HD) === 1, favorite: num(c.Favorite) === 1 });
        }
        return out;
    }
}
