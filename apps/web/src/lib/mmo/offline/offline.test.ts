import { describe, expect, it } from "vitest";
import {
    applyAuth, buildKey, mediaUrl, parseKey, parseOfflinePath, partUrl, posterUrl, scopeOf, scopeOfKey, stripAuth,
} from "./keys";
import { PART_SIZE, QUOTA_RESERVE, formatBytes, percent, quotaDecision, sum } from "./math";
import { contentRange, parseRange, planSlices } from "./range";
import { isShellRequest, sliceResponse } from "./sw-handlers";

describe("offline keys", () => {
    const parts = { serverId: "dev:1", profileId: "kids/2", kind: "movie" as const, id: "a:b c" };

    it("builds serverId:profileId:kind:id with free-form parts encoded and round-trips", () => {
        const key = buildKey(parts);
        expect(key).toBe("dev%3A1:kids%2F2:movie:a%3Ab%20c");
        expect(parseKey(key)).toEqual(parts);
    });

    it("rejects missing parts and unknown kinds", () => {
        expect(() => buildKey({ ...parts, id: "" })).toThrow();
        expect(() => buildKey({ ...parts, kind: "album" as never })).toThrow();
        expect(parseKey("a:b:album:c")).toBeNull();
        expect(parseKey("a:b:movie")).toBeNull();
    });

    it("scopes a key to its server + profile", () => {
        const key = buildKey(parts);
        expect(scopeOfKey(key)).toBe(scopeOf(parts.serverId, parts.profileId));
    });

    it("maps synthetic URLs back to the key and refuses internal entries", () => {
        const key = buildKey(parts);
        const path = (u: string) => new URL(u, "https://x.test").pathname;
        expect(parseOfflinePath(path(mediaUrl(key)))).toEqual({ key, sub: "media" });
        expect(parseOfflinePath(path(posterUrl(key)))).toEqual({ key, sub: "poster" });
        expect(parseOfflinePath(path(partUrl(key, 0)))).toBeNull();
        expect(parseOfflinePath("/__offline/not-a-key")).toBeNull();
        expect(parseOfflinePath("/media/downloads")).toBeNull();
    });

    it("strips credentials before persisting and re-applies them", () => {
        const s = stripAuth("https://srv.test/video/direct/f1?t=SECRET&u=u1&x=1");
        expect(s.url).toBe("https://srv.test/video/direct/f1?x=1");
        expect(s.url).not.toContain("SECRET");
        expect(s.auth).toEqual(["t", "u"]);
        expect(s.creds).toEqual({ token: "SECRET", userId: "u1" });
        expect(applyAuth(s.url, s.auth, { token: "NEW", userId: "u1" })).toBe("https://srv.test/video/direct/f1?x=1&t=NEW&u=u1");

        const sub = stripAuth("https://srv.test/rest/stream.view?id=tr_1&f=json&apiKey=K");
        expect(sub.auth).toEqual(["apiKey"]);
        expect(sub.url).not.toContain("apiKey");
    });
});

describe("range parsing", () => {
    it("handles absent, open, closed, suffix and clamped ranges", () => {
        expect(parseRange(null, 100)).toBeNull();
        expect(parseRange("items=0-1", 100)).toBeNull();
        expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
        expect(parseRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
        expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
        expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
        expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
        expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
    });

    it("reports unsatisfiable ranges", () => {
        expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
        expect(parseRange("bytes=20-10", 100)).toBe("unsatisfiable");
        expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
        expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
    });

    it("plans part slices across boundaries", () => {
        const parts = [10, 10, 5];
        expect(planSlices(parts, 0, 24)).toEqual([{ index: 0, from: 0, to: 9 }, { index: 1, from: 0, to: 9 }, { index: 2, from: 0, to: 4 }]);
        expect(planSlices(parts, 8, 12)).toEqual([{ index: 0, from: 8, to: 9 }, { index: 1, from: 0, to: 2 }]);
        expect(planSlices(parts, 21, 21)).toEqual([{ index: 2, from: 1, to: 1 }]);
        expect(contentRange({ start: 8, end: 12 }, 25)).toBe("bytes 8-12/25");
    });
});

describe("sliceResponse (SW /__offline answer)", () => {
    const bytes = Array.from({ length: 25 }, (_, i) => i);
    const blobs = [new Blob([new Uint8Array(bytes.slice(0, 10))]), new Blob([new Uint8Array(bytes.slice(10, 20))]), new Blob([new Uint8Array(bytes.slice(20))])];
    const manifest = { size: 25, parts: [10, 10, 5], type: "video/mp4" };
    const body = async (r: Response) => Array.from(new Uint8Array(await r.arrayBuffer()));

    it("returns the full file with 200 and Accept-Ranges", async () => {
        const r = sliceResponse(manifest, blobs, null);
        expect(r.status).toBe(200);
        expect(r.headers.get("Accept-Ranges")).toBe("bytes");
        expect(r.headers.get("Content-Length")).toBe("25");
        expect(r.headers.get("Content-Type")).toBe("video/mp4");
        expect(await body(r)).toEqual(bytes);
    });

    it("returns 206 with the exact window across parts", async () => {
        const r = sliceResponse(manifest, blobs, "bytes=8-12");
        expect(r.status).toBe(206);
        expect(r.headers.get("Content-Range")).toBe("bytes 8-12/25");
        expect(r.headers.get("Content-Length")).toBe("5");
        expect(await body(r)).toEqual([8, 9, 10, 11, 12]);
    });

    it("serves open-ended and suffix ranges", async () => {
        expect(await body(sliceResponse(manifest, blobs, "bytes=22-"))).toEqual([22, 23, 24]);
        expect(await body(sliceResponse(manifest, blobs, "bytes=-2"))).toEqual([23, 24]);
    });

    it("answers 416 with the size for unsatisfiable ranges", () => {
        const r = sliceResponse(manifest, blobs, "bytes=30-");
        expect(r.status).toBe(416);
        expect(r.headers.get("Content-Range")).toBe("bytes */25");
    });

    it("404s when a needed part is missing", () => {
        expect(sliceResponse(manifest, [blobs[0]!], "bytes=0-15").status).toBe(404);
    });
});

describe("shell routing", () => {
    const req = (init: { mode?: RequestMode; referrer?: string }) => ({ mode: init.mode ?? "no-cors", referrer: init.referrer ?? "" }) as Request;
    const u = (p: string) => new URL(p, "https://mixai.test");

    it("routes downloads navigations and shell files, not other pages", () => {
        expect(isShellRequest(u("/media/downloads"), req({ mode: "navigate" }))).toBe(true);
        expect(isShellRequest(u("/media/downloads/play/x"), req({ mode: "navigate" }))).toBe(true);
        expect(isShellRequest(u("/offline/downloads.js"), req({}))).toBe(true);
        expect(isShellRequest(u("/media"), req({ mode: "navigate" }))).toBe(false);
        expect(isShellRequest(u("/media/downloadsx"), req({ mode: "navigate" }))).toBe(false);
    });

    it("serves tokens CSS from the shell cache only for downloads documents", () => {
        expect(isShellRequest(u("/globals.css"), req({ referrer: "https://mixai.test/media/downloads" }))).toBe(true);
        expect(isShellRequest(u("/globals.css"), req({ referrer: "https://mixai.test/media" }))).toBe(false);
        expect(isShellRequest(u("/globals.css"), req({}))).toBe(false);
    });
});

describe("progress, quota and sizes", () => {
    it("computes whole percents and unknown totals", () => {
        expect(percent(0, 100)).toBe(0);
        expect(percent(50, 200)).toBe(25);
        expect(percent(199, 200)).toBe(99);
        expect(percent(300, 200)).toBe(100);
        expect(percent(10, null)).toBeNull();
        expect(percent(10, 0)).toBeNull();
        expect(sum([1, 2, 3])).toBe(6);
        expect(PART_SIZE).toBeGreaterThan(1024 * 1024);
    });

    it("decides quota with a reserve", () => {
        const GB = 1_000_000_000;
        expect(quotaDecision({ usage: 0, quota: 0, needed: GB })).toEqual({ ok: true, free: null });
        expect(quotaDecision({ usage: GB, quota: 10 * GB, needed: 2 * GB })).toEqual({ ok: true, free: 9 * GB });
        expect(quotaDecision({ usage: 9 * GB, quota: 10 * GB, needed: GB })).toEqual({ ok: false, free: GB, needed: GB });
        expect(quotaDecision({ usage: 0, quota: QUOTA_RESERVE / 2, needed: null })).toEqual({ ok: false, free: QUOTA_RESERVE / 2, needed: QUOTA_RESERVE });
    });

    it("formats sizes per locale", () => {
        expect(formatBytes(0, "en")).toMatch(/^0\s?byte/);
        expect(formatBytes(1_200_000_000, "en")).toBe("1.2 GB");
        expect(formatBytes(1_200_000_000, "ro")).toBe("1,2 GB");
        expect(formatBytes(345_000_000, "en")).toBe("345 MB");
    });
});
