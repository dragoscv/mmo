import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { catalog, findPack, packsDir } from "./catalog";

describe("decks-packs catalogue", () => {
    it("matches the MarketCatalog contract", () => {
        expect(catalog.v).toBe(1);
        expect(Number.isNaN(Date.parse(catalog.generatedAt))).toBe(false);
        for (const p of catalog.packs) {
            expect(p.id).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+){1,6}$/);
            expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(["skin", "layout", "bundle", "controller"]).toContain(p.kind);
            expect(typeof p.pro).toBe("boolean");
            expect(p.previewUrl).toBe(`/api/decks/packs/${p.id}/preview`);
            expect(existsSync(path.join(packsDir(), "previews", `${p.id}.png`))).toBe(true);
        }
    });

    it("only the festival bundle is pro", () => {
        expect(catalog.packs.filter((p) => p.pro).map((p) => p.id)).toEqual(["ro.mixai.bundle.festival-pro"]);
    });

    it("findPack resolves known ids only", () => {
        expect(findPack("ro.mixai.skin.vinyl-warm")?.kind).toBe("skin");
        expect(findPack("../files/ro.mixai.skin.vinyl-warm")).toBeNull();
        expect(findPack("")).toBeNull();
    });
});
