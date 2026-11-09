import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    findDeviceByToken: vi.fn(),
    getSubscription: vi.fn(),
    hasEntitlement: vi.fn(),
    requireRate: vi.fn(() => null as Response | null),
}));

vi.mock("@/lib/device-token", () => ({ findDeviceByToken: mocks.findDeviceByToken }));
vi.mock("@/lib/stripe", () => ({ getSubscription: mocks.getSubscription }));
vi.mock("@/lib/entitlements", () => ({ hasEntitlement: mocks.hasEntitlement }));
vi.mock("@/lib/api-guard", () => ({ requireRate: mocks.requireRate }));

import { GET as listGET, OPTIONS as listOPTIONS } from "./route";
import { GET as downloadGET } from "./[id]/download/route";
import { GET as previewGET } from "./[id]/preview/route";
import { catalog } from "@/lib/decks-packs/catalog";

const FREE = "ro.mixai.skin.neon-club";
const PRO = "ro.mixai.bundle.festival-pro";
const TOKEN = "dev_0123456789abcdef0123456789abcdef";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (url: string, headers: Record<string, string> = {}) => new NextRequest(`https://mixai.ro${url}`, { headers });

beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRate.mockReturnValue(null);
});

describe("GET /api/decks/packs", () => {
    it("returns the catalogue with CORS and cache headers", async () => {
        const res = listGET();
        expect(res.status).toBe(200);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("cache-control")).toBe("public, max-age=300");
        const body = await res.json();
        expect(body.v).toBe(1);
        expect(body.packs.map((p: { id: string }) => p.id).sort()).toEqual([PRO, "ro.mixai.layout.radio-host", FREE, "ro.mixai.skin.vinyl-warm"].sort());
        expect(body.packs.every((p: { trust: string }) => p.trust === "official")).toBe(true);
    });

    it("answers the CORS preflight", () => {
        const res = listOPTIONS();
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });
});

describe("catalogue integrity", () => {
    it("every pack file exists with the catalogued size and sha256", () => {
        for (const p of catalog.packs) {
            const bytes = readFileSync(path.join(process.cwd(), "src/lib/decks-packs/files", `${p.id}.mixaipack`));
            expect(bytes.length).toBe(p.size);
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(p.sha256);
        }
    });
});

describe("GET /api/decks/packs/[id]/download", () => {
    it("serves a free pack without auth, with ETag = sha256", async () => {
        const res = await downloadGET(req(`/api/decks/packs/${FREE}/download`), params(FREE));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/octet-stream");
        expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${FREE}.mixaipack"`);
        const bytes = Buffer.from(await res.arrayBuffer());
        const sha = createHash("sha256").update(bytes).digest("hex");
        expect(res.headers.get("etag")).toBe(`"${sha}"`);
        expect(sha).toBe(catalog.packs.find((p) => p.id === FREE)!.sha256);
        expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
        expect(mocks.findDeviceByToken).not.toHaveBeenCalled();
    });

    it("returns 304 for a matching If-None-Match", async () => {
        const sha = catalog.packs.find((p) => p.id === FREE)!.sha256;
        const res = await downloadGET(req(`/api/decks/packs/${FREE}/download`, { "if-none-match": `"${sha}"` }), params(FREE));
        expect(res.status).toBe(304);
    });

    it("404s unknown ids and path traversal attempts", async () => {
        for (const id of ["nope.pack.id", "../catalog", "..%2F..%2Fpackage.json", "ro.mixai.skin.neon-club/../x"]) {
            const res = await downloadGET(req(`/api/decks/packs/x/download`), params(id));
            expect(res.status).toBe(404);
        }
    });

    it("pro pack without a bearer -> 401 pro_required", async () => {
        const res = await downloadGET(req(`/api/decks/packs/${PRO}/download`), params(PRO));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "pro_required" });
        expect(mocks.findDeviceByToken).not.toHaveBeenCalled();
    });

    it("pro pack with an unknown device token -> 401", async () => {
        mocks.findDeviceByToken.mockResolvedValue(null);
        const res = await downloadGET(req(`/api/decks/packs/${PRO}/download`, { authorization: `Bearer ${TOKEN}` }), params(PRO));
        expect(res.status).toBe(401);
        expect(mocks.findDeviceByToken).toHaveBeenCalledWith(TOKEN);
    });

    it("pro pack for a user without decks_pro -> 402", async () => {
        mocks.findDeviceByToken.mockResolvedValue({ id: "d1", userId: "u1" });
        mocks.getSubscription.mockResolvedValue({ plan: "free", isPro: false });
        mocks.hasEntitlement.mockReturnValue(false);
        const res = await downloadGET(req(`/api/decks/packs/${PRO}/download`, { authorization: `Bearer ${TOKEN}` }), params(PRO));
        expect(res.status).toBe(402);
        expect(await res.json()).toEqual({ error: "pro_required" });
        expect(mocks.getSubscription).toHaveBeenCalledWith("u1");
        expect(mocks.hasEntitlement).toHaveBeenCalledWith({ plan: "free", isPro: false }, "decks_pro");
    });

    it("pro pack for an entitled user -> 200, not publicly cacheable", async () => {
        mocks.findDeviceByToken.mockResolvedValue({ id: "d1", userId: "u1" });
        mocks.getSubscription.mockResolvedValue({ plan: "pro_yearly", isPro: true });
        mocks.hasEntitlement.mockReturnValue(true);
        const res = await downloadGET(req(`/api/decks/packs/${PRO}/download`, { authorization: `Bearer ${TOKEN}` }), params(PRO));
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        const bytes = Buffer.from(await res.arrayBuffer());
        expect(bytes.length).toBe(catalog.packs.find((p) => p.id === PRO)!.size);
    });

    it("pro downloads are rate limited", async () => {
        mocks.requireRate.mockReturnValue(new Response("slow down", { status: 429 }));
        const res = await downloadGET(req(`/api/decks/packs/${PRO}/download`, { authorization: `Bearer ${TOKEN}` }), params(PRO));
        expect(res.status).toBe(429);
        expect(mocks.findDeviceByToken).not.toHaveBeenCalled();
    });
});

describe("GET /api/decks/packs/[id]/preview", () => {
    it("serves the build-time preview PNG", async () => {
        const res = await previewGET(req(`/api/decks/packs/${FREE}/preview`), params(FREE));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        const bytes = Buffer.from(await res.arrayBuffer());
        expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
    });

    it("404s unknown ids", async () => {
        const res = await previewGET(req(`/api/decks/packs/x/preview`), params("../../package"));
        expect(res.status).toBe(404);
    });
});
