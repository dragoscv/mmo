import { afterEach, describe, expect, it, vi } from "vitest";
import { hostKind, hostRoutingEnabled, hrefFor, internalPathname, midiHostAllowed, ownerOf, productOrigin, renamedHostOrigin, routeRequest, toInternal, toPublic } from "./products";
import { MEDIA_NAV } from "@/components/mmo/media-shell";

vi.mock("@/components/host/host-context", () => ({ default: () => null, usePathname: () => "/", useRouter: () => ({}), useHost: () => ({}) }));
vi.mock("@/components/mmo/mmo-provider", () => ({ useMmo: () => ({}) }));
vi.mock("@/components/mmo/profile-gate", () => ({ ProfileGate: () => null }));
vi.mock("@/components/mmo/profile-menu", () => ({ ProfileMenu: () => null }));
vi.mock("@/components/mmo/music/mini-player", () => ({ MusicMiniPlayer: () => null }));
vi.mock("@mmo/ui", () => ({ Button: () => null, EmptyState: () => null }));
vi.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));

describe("hostRoutingEnabled", () => {
    afterEach(() => { vi.unstubAllEnvs(); });
    it("is off unless MIXAI_HOST_ROUTING=1", () => {
        vi.stubEnv("MIXAI_HOST_ROUTING", "");
        expect(hostRoutingEnabled()).toBe(false);
        vi.stubEnv("MIXAI_HOST_ROUTING", "true");
        expect(hostRoutingEnabled()).toBe(false);
        vi.stubEnv("MIXAI_HOST_ROUTING", "1");
        expect(hostRoutingEnabled()).toBe(true);
    });
});
import { authCookiesFor, isAllowedRedirect, sessionCookieFor } from "./auth-cookies";
import { centralLoginUrl, safeCallback } from "./login";

describe("central login", () => {
    it("accepts absolute product callbacks only on product hosts", () => {
        expect(safeCallback("/x", "legacy")).toBe("/x");
        expect(safeCallback("//evil.com", "suite")).toBe("/");
        expect(safeCallback("/\\evil.com", "suite")).toBe("/");
        expect(safeCallback("https://tv.mixai.ro/live", "suite")).toBe("https://tv.mixai.ro/live");
        expect(safeCallback("https://tv.mixai.ro/live", "legacy")).toBe("/");
        expect(safeCallback("https://evil.com/", "suite")).toBe("/");
        expect(safeCallback("http://tv.mixai.ro/", "suite")).toBe("/");
    });
    it("sends sub-product hosts to the apex login with an absolute callback", () => {
        expect(centralLoginUrl("suite", "/")).toBeNull();
        expect(centralLoginUrl("legacy", "/media")).toBeNull();
        expect(centralLoginUrl("tv", "/media")).toBe(`https://mixai.ro/login?callbackUrl=${encodeURIComponent("https://tv.mixai.ro/")}`);
        expect(centralLoginUrl("tv", "/media/music")).toBe(`https://mixai.ro/login?callbackUrl=${encodeURIComponent("https://music.mixai.ro/")}`);
        // media layout on music.mixai.ro (desktop shell's start page) must come back to Music, not TV.
        expect(centralLoginUrl("music", "/media/music")).toBe(`https://mixai.ro/login?callbackUrl=${encodeURIComponent("https://music.mixai.ro/")}`);
        expect(centralLoginUrl("studio", "https://app.mixai.ro/library")).toBe(`https://mixai.ro/login?callbackUrl=${encodeURIComponent("https://app.mixai.ro/library")}`);
    });
});

describe("hostKind", () => {
    it("maps product subdomains and leaves every other host legacy", () => {
        expect(hostKind("mixai.ro")).toBe("suite");
        expect(hostKind("WWW.mixai.ro:443")).toBe("suite");
        expect(hostKind("tv.mixai.ro")).toBe("tv");
        expect(hostKind("music.mixai.ro")).toBe("music");
        expect(hostKind("app.mixai.ro")).toBe("studio");
        expect(hostKind("dj.mixai.ro")).toBe("dj");
        expect(hostKind("decks.mixai.ro")).toBe("dj");
        expect(hostKind("demo.mixai.ro")).toBe("legacy");
        expect(hostKind("mixai-web-abc-ew.a.run.app")).toBe("legacy");
        expect(hostKind("localhost:13789")).toBe("legacy");
        expect(hostKind("evilmixai.ro")).toBe("legacy");
        expect(hostKind(null)).toBe("legacy");
    });
});

describe("ownerOf / mapping", () => {
    it("assigns internal routes to products", () => {
        expect(ownerOf("/media")).toBe("tv");
        expect(ownerOf("/media/movie/1")).toBe("tv");
        expect(ownerOf("/media/music/album/a")).toBe("music");
        expect(ownerOf("/library")).toBe("studio");
        expect(ownerOf("/settings/account")).toBe("studio");
        expect(ownerOf("/")).toBe("suite");
        expect(ownerOf("/dj")).toBe("dj");
        expect(ownerOf("/privacy")).toBeNull();
        expect(ownerOf("/login")).toBeNull();
        expect(ownerOf("/icon-192.png")).toBeNull();
    });
    it("round-trips public and internal paths", () => {
        expect(toInternal("tv", "/")).toBe("/media");
        expect(toInternal("tv", "/browse/movie")).toBe("/media/browse/movie");
        expect(toInternal("tv", "/library")).toBeNull();
        expect(toInternal("music", "/album/x")).toBe("/media/music/album/x");
        expect(toPublic("tv", "/media/live/guide")).toBe("/live/guide");
        expect(toPublic("music", "/media/music")).toBe("/");
    });
});

describe("hrefFor", () => {
    it("keeps internal hrefs on legacy hosts", () => {
        expect(hrefFor("/media/browse/movie", "legacy")).toBe("/media/browse/movie");
    });
    it("cleans same-product hrefs and keeps query + hash", () => {
        expect(hrefFor("/media/play/movie/5?t=10#x", "tv")).toBe("/play/movie/5?t=10#x");
        expect(hrefFor("/media", "tv")).toBe("/");
    });
    it("goes absolute across products", () => {
        expect(hrefFor("/media/music/album/a", "tv")).toBe("https://music.mixai.ro/album/a");
        expect(hrefFor("/media/movie/1", "music")).toBe("https://tv.mixai.ro/movie/1");
        expect(hrefFor("/pair", "tv")).toBe("/pair");
        expect(hrefFor("/library", "tv")).toBe("https://app.mixai.ro/library");
    });
    it("leaves external and protocol-relative hrefs alone", () => {
        expect(hrefFor("https://x.y/z", "tv")).toBe("https://x.y/z");
        expect(hrefFor("//x.y/z", "tv")).toBe("//x.y/z");
    });
    it("TV nav's Music entry crosses to music.mixai.ro (WP17-45)", () => {
        const music = MEDIA_NAV.find((n) => n.key === "music");
        expect(music?.href).toBe("/media/music");
        expect(hrefFor(music!.href, "tv")).toBe("https://music.mixai.ro/");
        expect(hrefFor(music!.href, "suite")).toBe("https://music.mixai.ro/");
        expect(hrefFor(music!.href, "music")).toBe("/");
        expect(hrefFor(music!.href, "legacy")).toBe("/media/music");
        expect(hrefFor(music!.href, "tv", "staging.mixai.ro")).toBe("https://music.staging.mixai.ro/");
    });
    it("keeps desktop / mixai-music:// intents when canonicalising (WP17-43)", () => {
        expect(midiHostAllowed("music")).toBe(false);
        expect(midiHostAllowed("tv")).toBe(false);
        expect(midiHostAllowed("suite")).toBe(false);
        expect(midiHostAllowed("studio")).toBe(true);
        expect(midiHostAllowed("dj")).toBe(true);
        expect(midiHostAllowed("legacy")).toBe(true);
        expect(routeRequest("music.mixai.ro", "/media/music", "?play=tr_1,tr_2&index=1")).toEqual({
            type: "redirect", url: "https://music.mixai.ro/?play=tr_1,tr_2&index=1", status: 308,
        });
        expect(routeRequest("music.mixai.ro", "/media/music/search", "?q=x&play=1")).toEqual({
            type: "redirect", url: "https://music.mixai.ro/search?q=x&play=1", status: 308,
        });
        expect(routeRequest("music.mixai.ro", "/media/downloads")).toEqual({ type: "next" });
    });
    it("maps the public pathname back for active-nav checks", () => {
        expect(internalPathname("/browse/tv", "tv")).toBe("/media/browse/tv");
        expect(internalPathname("/", "tv")).toBe("/media");
        expect(internalPathname("/", "studio")).toBe("/dashboard");
        expect(internalPathname("/media/x", "legacy")).toBe("/media/x");
    });
});

describe("routeRequest", () => {
    it("never touches legacy hosts", () => {
        expect(routeRequest("mixai-web-x.run.app", "/media/browse/movie")).toEqual({ type: "next" });
        expect(routeRequest("localhost:13789", "/library")).toEqual({ type: "next" });
    });
    it("308s old apex paths to their product host", () => {
        expect(routeRequest("mixai.ro", "/media/movie/12", "?play=1")).toEqual({ type: "redirect", url: "https://tv.mixai.ro/movie/12?play=1", status: 308 });
        expect(routeRequest("mixai.ro", "/media/music/artist/a")).toEqual({ type: "redirect", url: "https://music.mixai.ro/artist/a", status: 308 });
        expect(routeRequest("mixai.ro", "/library")).toEqual({ type: "redirect", url: "https://app.mixai.ro/library", status: 308 });
        expect(routeRequest("www.mixai.ro", "/settings")).toEqual({ type: "redirect", url: "https://app.mixai.ro/settings", status: 308 });
    });
    it("keeps the apex landing and shared pages on the apex", () => {
        expect(routeRequest("mixai.ro", "/")).toEqual({ type: "next" });
        expect(routeRequest("mixai.ro", "/privacy")).toEqual({ type: "next" });
        expect(routeRequest("mixai.ro", "/login")).toEqual({ type: "next" });
        expect(routeRequest("mixai.ro", "/get")).toEqual({ type: "next" });
    });
    it("rewrites clean TV and Music URLs", () => {
        expect(routeRequest("tv.mixai.ro", "/")).toEqual({ type: "rewrite", path: "/media" });
        expect(routeRequest("tv.mixai.ro", "/live/guide")).toEqual({ type: "rewrite", path: "/media/live/guide" });
        expect(routeRequest("music.mixai.ro", "/")).toEqual({ type: "rewrite", path: "/media/music" });
        expect(routeRequest("music.mixai.ro", "/now-playing")).toEqual({ type: "rewrite", path: "/media/music/now-playing" });
    });
    it("canonicalises internal paths on product hosts", () => {
        expect(routeRequest("tv.mixai.ro", "/media/browse/tv")).toEqual({ type: "redirect", url: "https://tv.mixai.ro/browse/tv", status: 308 });
        expect(routeRequest("tv.mixai.ro", "/music/album/a")).toEqual({ type: "redirect", url: "https://music.mixai.ro/album/a", status: 308 });
        expect(routeRequest("tv.mixai.ro", "/settings")).toEqual({ type: "redirect", url: "https://app.mixai.ro/settings", status: 308 });
    });
    it("serves Studio at app.mixai.ro with the dashboard as its home", () => {
        expect(routeRequest("app.mixai.ro", "/")).toEqual({ type: "rewrite", path: "/dashboard" });
        expect(routeRequest("app.mixai.ro", "/library")).toEqual({ type: "next" });
        expect(routeRequest("app.mixai.ro", "/media")).toEqual({ type: "redirect", url: "https://tv.mixai.ro/", status: 308 });
    });
    it("lets shared paths render on every host", () => {
        expect(routeRequest("tv.mixai.ro", "/login")).toEqual({ type: "next" });
        expect(routeRequest("music.mixai.ro", "/privacy")).toEqual({ type: "next" });
        expect(routeRequest("app.mixai.ro", "/pair")).toEqual({ type: "next" });
    });
    it("opens downloads on the host that saved them (per-origin storage)", () => {
        expect(routeRequest("music.mixai.ro", "/media/downloads")).toEqual({ type: "next" });
        expect(routeRequest("music.mixai.ro", "/media/downloads/play/k")).toEqual({ type: "next" });
        expect(routeRequest("tv.mixai.ro", "/media/downloads")).toEqual({ type: "next" });
        expect(routeRequest("tv.mixai.ro", "/downloads")).toEqual({ type: "rewrite", path: "/media/downloads" });
        expect(hrefFor("/media/downloads", "music")).toBe("/media/downloads");
    });
    it("honours a staging root domain", () => {
        expect(routeRequest("tv.staging.mixai.ro", "/", "", "staging.mixai.ro")).toEqual({ type: "rewrite", path: "/media" });
        expect(routeRequest("staging.mixai.ro", "/library", "", "staging.mixai.ro")).toEqual({ type: "redirect", url: "https://app.staging.mixai.ro/library", status: 308 });
    });
    it("serves MixAI Decks at decks.mixai.ro and 308s the old dj.mixai.ro host (D60, ADR-0014)", () => {
        expect(productOrigin("dj")).toBe("https://decks.mixai.ro");
        expect(routeRequest("decks.mixai.ro", "/")).toEqual({ type: "rewrite", path: "/dj" });
        expect(routeRequest("decks.mixai.ro", "/dj")).toEqual({ type: "redirect", url: "https://decks.mixai.ro/", status: 308 });
        expect(routeRequest("mixai.ro", "/dj")).toEqual({ type: "redirect", url: "https://decks.mixai.ro/", status: 308 });
        expect(routeRequest("decks.mixai.ro", "/library")).toEqual({ type: "redirect", url: "https://app.mixai.ro/library", status: 308 });
        expect(routeRequest("dj.mixai.ro", "/")).toEqual({ type: "redirect", url: "https://decks.mixai.ro/", status: 308 });
        expect(routeRequest("DJ.mixai.ro:443", "/get", "?p=windows&x=1")).toEqual({ type: "redirect", url: "https://decks.mixai.ro/get?p=windows&x=1", status: 308 });
        expect(routeRequest("dj.mixai.ro", "/privacy")).toEqual({ type: "redirect", url: "https://decks.mixai.ro/privacy", status: 308 });
        expect(routeRequest("dj.staging.mixai.ro", "/a", "", "staging.mixai.ro")).toEqual({ type: "redirect", url: "https://decks.staging.mixai.ro/a", status: 308 });
        expect(renamedHostOrigin("decks.mixai.ro")).toBeNull();
        expect(renamedHostOrigin("dj.evil.com")).toBeNull();
        expect(hrefFor("/dj", "suite")).toBe("https://decks.mixai.ro/");
    });
});

describe("session cookie", () => {
    it("shares the cookie across *.mixai.ro over https only", () => {
        expect(sessionCookieFor("tv.mixai.ro", true)).toEqual({ name: "__Secure-mixai.session-token", domain: ".mixai.ro", secure: true });
        expect(sessionCookieFor("mixai.ro", true).domain).toBe(".mixai.ro");
        expect(sessionCookieFor("x.run.app", true)).toEqual({ name: "__Secure-authjs.session-token", secure: true });
        expect(sessionCookieFor("localhost", false)).toEqual({ name: "authjs.session-token", secure: false });
        expect(authCookiesFor("x.run.app", true)).toBeUndefined();
        expect(authCookiesFor("app.mixai.ro", true)?.sessionToken.options.domain).toBe(".mixai.ro");
    });
    it("allows redirects across product hosts only", () => {
        expect(isAllowedRedirect("https://tv.mixai.ro/x", "https://mixai.ro")).toBe(true);
        expect(isAllowedRedirect("https://mixai.ro/", "https://app.mixai.ro")).toBe(true);
        expect(isAllowedRedirect("http://tv.mixai.ro/x", "https://mixai.ro")).toBe(false);
        expect(isAllowedRedirect("https://evil.com/", "https://mixai.ro")).toBe(false);
        expect(isAllowedRedirect("https://tv.mixai.ro/", "https://x.run.app")).toBe(false);
        expect(isAllowedRedirect("https://x.run.app/a", "https://x.run.app")).toBe(true);
        expect(isAllowedRedirect("https://evilmixai.ro/", "https://mixai.ro")).toBe(false);
    });
});
