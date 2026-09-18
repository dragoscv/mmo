import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mgmt.ts imports the DB module for persistence helpers; stub it so the
// pure mgmt-API functions can be tested without a connection.
vi.mock("@/db", () => ({ db: {} }));

import { CodaiMgmtError, canMintUserKeys, listUserKeys, mintUserKey, revokeUserKey, userKeyLabel } from "./mgmt";

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("codai mgmt", () => {
    beforeEach(() => {
        process.env.CODAI_APP_TOKEN = "codai_app_test";
        delete process.env.CODAI_MGMT_URL;
        delete process.env.CODAI_USER_BUDGET_EUR_PER_DAY;
        fetchMock.mockReset();
        vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.CODAI_APP_TOKEN;
    });

    it("canMintUserKeys follows CODAI_APP_TOKEN", () => {
        expect(canMintUserKeys()).toBe(true);
        delete process.env.CODAI_APP_TOKEN;
        expect(canMintUserKeys()).toBe(false);
    });

    it("mintUserKey posts the right body and unwraps { ok, data }", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: "key_1", key: "codai_plain" } }));
        const minted = await mintUserKey({ userId: "u1", email: "a@b.ro" });
        expect(minted).toEqual({ id: "key_1", key: "codai_plain" });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe("https://api.codai.ro/apps/keys");
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer codai_app_test");
        expect(JSON.parse(String(init?.body))).toEqual({
            email: "a@b.ro",
            endUserExternalId: "u1",
            label: userKeyLabel("u1"),
            budgetEurPerDay: 1,
        });
    });

    it("honours CODAI_USER_BUDGET_EUR_PER_DAY and CODAI_MGMT_URL", async () => {
        process.env.CODAI_USER_BUDGET_EUR_PER_DAY = "2.5";
        process.env.CODAI_MGMT_URL = "https://mgmt.example/";
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: "k", key: "v" } }));
        await mintUserKey({ userId: "u", email: "e@x.ro" });
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe("https://mgmt.example/apps/keys");
        expect(JSON.parse(String(init?.body)).budgetEurPerDay).toBe(2.5);
    });

    it("throws CodaiMgmtError on ok:false envelope (HTTP 200)", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ ok: false, error: { code: "budget_exceeded", message: "App budget exhausted" } }),
        );
        const err = await mintUserKey({ userId: "u", email: "e@x.ro" }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CodaiMgmtError);
        expect((err as CodaiMgmtError).code).toBe("budget_exceeded");
        expect((err as CodaiMgmtError).message).toMatch(/App budget exhausted/);
    });

    it("throws CodaiMgmtError with status on non-2xx", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, error: "forbidden" }, 403));
        const err = await mintUserKey({ userId: "u", email: "e@x.ro" }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CodaiMgmtError);
        expect((err as CodaiMgmtError).status).toBe(403);
        expect((err as CodaiMgmtError).message).toMatch(/forbidden/);
    });

    it("throws on malformed envelope / missing key", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ id: "no-envelope" }));
        await expect(mintUserKey({ userId: "u", email: "e@x.ro" })).rejects.toMatchObject({ code: "malformed" });

        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: "k" } }));
        await expect(mintUserKey({ userId: "u", email: "e@x.ro" })).rejects.toMatchObject({ code: "malformed" });
    });

    it("throws not_configured without CODAI_APP_TOKEN", async () => {
        delete process.env.CODAI_APP_TOKEN;
        await expect(mintUserKey({ userId: "u", email: "e@x.ro" })).rejects.toMatchObject({ code: "not_configured" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("revokeUserKey DELETEs /apps/keys/:id", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { revoked: true } }));
        await revokeUserKey("key/with slash");
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe("https://api.codai.ro/apps/keys/key%2Fwith%20slash");
        expect(init?.method).toBe("DELETE");
    });

    it("listUserKeys accepts array or { keys } payloads", async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: [{ id: "a" }] }));
        expect(await listUserKeys("u1")).toEqual([{ id: "a" }]);
        expect(fetchMock.mock.calls[0]![0]).toBe("https://api.codai.ro/apps/keys?endUserExternalId=u1");

        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { keys: [{ id: "b" }] } }));
        expect(await listUserKeys("u1")).toEqual([{ id: "b" }]);
    });
});
