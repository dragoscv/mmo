import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hostBrand, hostBrandAssets } from "./brand";
import type { HostKind } from "./products";

const PUBLIC = path.resolve(__dirname, "../../../public");
const KINDS: HostKind[] = ["suite", "tv", "music", "studio", "dj", "live", "legacy"];

interface ManifestIcon { src: string; sizes: string; type: string; purpose: string }
interface WebManifest { name: string; short_name: string; start_url: string; id: string; scope?: string; theme_color: string; background_color: string; icons: ManifestIcon[] }

const inPublic = (url: string) => path.join(PUBLIC, url.replace(/^\//, ""));
const readManifest = (url: string) => JSON.parse(readFileSync(inPublic(url), "utf8")) as WebManifest;

/** PNG width × height from the IHDR chunk (no image library needed). */
function pngSize(file: string): [number, number] {
    const b = readFileSync(file);
    expect(b.subarray(1, 4).toString("latin1")).toBe("PNG");
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe("hostBrand", () => {
    it("maps every host to its mark; Decks lives under the `dj` route key", () => {
        expect(KINDS.map(hostBrand)).toEqual(["mark", "tv", "music", "studio", "decks", "live", "mark"]);
    });

    it("gives the suite root and legacy hosts the family files without a suffix", () => {
        expect(hostBrandAssets("suite")).toMatchObject({ iconSvg: "/icon.svg", appleTouchIcon: "/apple-touch-icon.png", ogImage: "/og-image.png", manifest: "/manifest-suite.webmanifest" });
        expect(hostBrandAssets("legacy").manifest).toBe("/manifest.webmanifest");
        expect(hostBrandAssets("dj")).toMatchObject({ iconSvg: "/icon-decks.svg", manifest: "/manifest-decks.webmanifest", name: "MixAI Decks" });
    });
});

describe.each(KINDS)("brand files of the %s host", (kind) => {
    const a = hostBrandAssets(kind);

    it("exist in public/ with the sizes the <head> declares", () => {
        for (const url of [a.iconSvg, a.favicon, a.appleTouchIcon, a.ogImage, a.manifest]) expect(existsSync(inPublic(url)), url).toBe(true);
        expect(pngSize(inPublic(a.appleTouchIcon))).toEqual([180, 180]);
        expect(pngSize(inPublic(a.ogImage))).toEqual([1200, 630]);
        expect(readFileSync(inPublic(a.iconSvg), "utf8")).toContain(`aria-label="${a.name.replace("&", "&amp;")}"`);
    });

    it("has a manifest named after the product, with 192 + 512 `any` icons and a separate maskable one", () => {
        const m = readManifest(a.manifest);
        expect(m.name).toBe(a.name);
        expect(m.short_name).toBe(a.name);
        expect(m.start_url).toBe("/");
        expect(m.scope).toBe("/");
        const suffix = a.id === "mark" ? "" : `-${a.id}`;
        expect(m.icons).toEqual([
            { src: `/icon${suffix}-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
            { src: `/icon${suffix}-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
            { src: `/icon${suffix}-maskable-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
        ]);
        for (const icon of m.icons) {
            const [w, h] = icon.sizes.split("x").map(Number);
            expect(pngSize(inPublic(icon.src)), icon.src).toEqual([w, h]);
        }
    });
});

describe("manifests", () => {
    it("have one install id per product and share the colours", () => {
        const all = KINDS.map((k) => readManifest(hostBrandAssets(k).manifest));
        expect(new Set(all.map((m) => m.id)).size).toBe(KINDS.length);
        expect(new Set(all.map((m) => `${m.theme_color} ${m.background_color}`)).size).toBe(1);
    });
});
