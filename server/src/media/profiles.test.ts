import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "node:http";
import { openMemoryMediaDb } from "./db";
import { TmdbClient, type FetchLike } from "./tmdb";
import { ProviderRegistry } from "./providers";
import { AvailabilityResolver } from "./availability";
import { ProgressStore } from "./progress";
import { ProfileStore, PIN_MAX_TRIES, hashPin, verifyPin } from "./profiles";
import { WatchlistStore } from "./watchlist";
import { createMediaRouter, nextUp } from "./routes";
import { ageForCert, ageForRatings, allowedForAge, extractRatings } from "./ratings";
import { parseVersion } from "./versions";
import type { ProgressEntry } from "./types";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe("pin hashing", () => {
    it("verifies the right pin and rejects others", () => {
        const h = hashPin("1234");
        expect(h.startsWith("scrypt$")).toBe(true);
        expect(verifyPin("1234", h)).toBe(true);
        expect(verifyPin("4321", h)).toBe(false);
        expect(verifyPin("1234", "plain$x$y")).toBe(false);
    });
});

describe("ProfileStore", () => {
    it("seeds a default profile, creates kids with default max age, enforces pin + lockout", () => {
        let t = 1_000_000;
        const db = openMemoryMediaDb();
        const store = new ProfileStore(db, () => t);
        expect(store.list().map((p) => p.id)).toEqual(["default"]);
        const kid = store.create({ name: "Ana", kind: "kid" });
        expect(kid).toMatchObject({ kind: "kid", maxAge: 12, hasPin: false });
        const adult = store.create({ name: "Dragos", pin: "2468" });
        expect(adult.hasPin).toBe(true);
        expect(() => store.create({ name: "x", pin: "12" })).toThrow(/4 digits/);
        expect(() => store.create({ name: "" })).toThrow(/name/);

        for (let i = 1; i < PIN_MAX_TRIES; i++) {
            const r = store.unlock(adult.id, "0000");
            expect(r).toMatchObject({ ok: false, reason: "wrong_pin", triesLeft: PIN_MAX_TRIES - i });
        }
        expect(store.unlock(adult.id, "0000")).toMatchObject({ ok: false, reason: "locked" });
        expect(store.unlock(adult.id, "2468")).toMatchObject({ ok: false, reason: "locked" });
        t += 5 * 60_000 + 1;
        const ok = store.unlock(adult.id, "2468");
        expect(ok.ok).toBe(true);
        if (!ok.ok) return;
        expect(store.verifyToken(ok.token)).toBe(adult.id);
        expect(store.verifyToken(ok.token.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBeNull();
        t += 13 * 3600_000;
        expect(store.verifyToken(ok.token)).toBeNull();

        const upd = store.update(adult.id, { pin: null, prefs: { autoplay: false } });
        expect(upd).toMatchObject({ hasPin: false, prefs: { autoplay: false } });
        expect(store.remove(kid.id)).toBe(true);
        expect(store.remove(adult.id)).toBe(true);
        expect(() => store.remove("default")).toThrow(/last profile/);
    });
});

describe("ratings", () => {
    it("maps certifications to ages with region fallback", () => {
        expect(ageForCert("N-15", "RO")).toBe(15);
        expect(ageForCert("AP-12", "RO")).toBe(12);
        expect(ageForCert("PG-13", "US")).toBe(13);
        expect(ageForCert("TV-MA", "US")).toBe(18);
        expect(ageForCert("NR", "US")).toBeNull();
        expect(ageForCert("16", "DE")).toBe(16);
        expect(ageForRatings({ US: "R" }, "RO")).toBe(17);
        expect(ageForRatings({ RO: "AG", US: "R" }, "RO")).toBe(0);
        expect(ageForRatings({}, "RO")).toBeNull();
    });
    it("extracts per-country ratings preferring theatrical", () => {
        const raw = { release_dates: { results: [
            { iso_3166_1: "US", release_dates: [{ type: 4, certification: "PG" }, { type: 3, certification: "R" }] },
            { iso_3166_1: "RO", release_dates: [{ type: 3, certification: "" }] },
        ] } };
        expect(extractRatings(raw, "movie")).toEqual({ US: "R" });
        expect(extractRatings({ content_ratings: { results: [{ iso_3166_1: "RO", rating: "12" }] } }, "tv")).toEqual({ RO: "12" });
    });
    it("blocks unrated titles for kids unless family/kids genres", () => {
        expect(allowedForAge(15, 12)).toBe(false);
        expect(allowedForAge(12, 12)).toBe(true);
        expect(allowedForAge(null, 12, [28])).toBe(false);
        expect(allowedForAge(null, 12, [10751])).toBe(true);
        expect(allowedForAge(18, null)).toBe(true);
    });
});

describe("nextUp", () => {
    const e = (season: number, episode: number, completed: boolean, updatedAt: number, positionSec = 0): ProgressEntry => ({
        profileId: "p", kind: "tv", tmdbId: 1, season, episode, positionSec, durationSec: 100, completed, updatedAt,
    });
    const seasons = { seasons: [{ seasonNumber: 0, name: "S", episodeCount: 3, posterPath: null }, { seasonNumber: 1, name: "1", episodeCount: 2, posterPath: null }, { seasonNumber: 2, name: "2", episodeCount: 5, posterPath: null }] };
    it("resumes an unfinished episode, advances, rolls over seasons, ends", () => {
        expect(nextUp([e(1, 1, false, 5, 40)], seasons)).toEqual({ season: 1, episode: 1, positionSec: 40 });
        expect(nextUp([e(1, 1, true, 5)], seasons)).toEqual({ season: 1, episode: 2, positionSec: 0 });
        expect(nextUp([e(1, 1, true, 5), e(1, 2, true, 9)], seasons)).toEqual({ season: 2, episode: 1, positionSec: 0 });
        expect(nextUp([e(2, 5, true, 9)], seasons)).toBeNull();
        expect(nextUp([], seasons)).toBeNull();
    });
});

describe("parseVersion", () => {
    it("labels and ranks versions", () => {
        const a = parseVersion("D:\\Movies\\Dune (2021) 2160p DV REMUX.mkv");
        const b = parseVersion("D:\\Movies\\Dune (2021) 1080p Extended.mkv");
        expect(a).toMatchObject({ resolution: "2160p", hdr: "DV", remux: true, label: "4K · DV · Remux" });
        expect(b).toMatchObject({ resolution: "1080p", edition: "Extended", label: "1080p · Extended" });
        expect(a.rank).toBeGreaterThan(b.rank);
    });
});

describe("profiles + watchlist routes", () => {
    let server: http.Server;
    let base = "";
    beforeAll(async () => {
        const db = openMemoryMediaDb();
        const fetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({}) });
        const tmdb = new TmdbClient(db, { fetch });
        const registry = new ProviderRegistry(db, tmdb);
        const availability = new AvailabilityResolver({ db, tmdb, registry, fetch });
        const progress = new ProgressStore(db);
        const profiles = new ProfileStore(db);
        const watchlist = new WatchlistStore(db, progress);
        const app = express();
        app.use("/media", createMediaRouter({ db, tmdb, registry, availability, progress, profiles, watchlist, region: "RO", log: silent }));
        server = http.createServer(app);
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}/media`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    const j = async (path: string, init?: RequestInit) => {
        const res = await fetch(base + path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
        const text = await res.text();
        return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
    };

    it("creates a pin profile; scoped reads need the token", async () => {
        const created = await j("/profiles", { method: "POST", body: JSON.stringify({ name: "Ion", pin: "1357" }) });
        expect(created.status).toBe(201);
        const id = (created.body.profile as { id: string; hasPin: boolean }).id;
        expect((created.body.profile as { hasPin: boolean }).hasPin).toBe(true);
        expect(JSON.stringify(created.body)).not.toContain("1357");

        expect((await j(`/watchlist?profile=${id}`)).status).toBe(403);
        expect((await j(`/progress?profile=${id}`)).status).toBe(403);
        expect((await j(`/profiles/${id}/unlock`, { method: "POST", body: JSON.stringify({ pin: "0000" }) })).status).toBe(401);
        const ok = await j(`/profiles/${id}/unlock`, { method: "POST", body: JSON.stringify({ pin: "1357" }) });
        expect(ok.status).toBe(200);
        const headers = { "x-profile-token": String(ok.body.token) };

        const put = await j(`/watchlist/movie/550?profile=${id}`, { method: "PUT", headers });
        expect(put.status).toBe(200);
        const wl = await j(`/watchlist?profile=${id}`, { headers });
        expect((wl.body.entries as { tmdbId: number }[]).map((e) => e.tmdbId)).toEqual([550]);
        expect((await j(`/watchlist/movie/550?profile=${id}`, { method: "DELETE", headers })).body.removed).toBe(true);

        const list = await j("/profiles");
        expect((list.body.profiles as unknown[]).length).toBe(2);
        expect((await j(`/profiles/${id}`, { method: "PATCH", body: JSON.stringify({ name: "X" }) })).status).toBe(403);
        expect((await j(`/profiles/${id}`, { method: "PATCH", headers, body: JSON.stringify({ name: "Ionel" }) })).body.profile).toMatchObject({ name: "Ionel" });
        expect((await j(`/profiles/${id}`, { method: "DELETE", headers })).status).toBe(204);
    });

    it("default profile has no pin and season endpoint answers 503 without TMDB", async () => {
        expect((await j("/watchlist")).status).toBe(200);
        expect((await j("/title/tv/1399/season/1")).status).toBe(503);
        expect((await j("/title/tv/x/season/1")).status).toBe(400);
    });
});
