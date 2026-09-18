import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMmoServerClient } from "./mmo-server";

describe("createMmoServerClient", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(async () =>
            new Response(JSON.stringify({ status: "ok", version: "3.0.0" }), {
                status: 200,
                headers: { "content-type": "application/json" },
            }),
        );
    });

    function request(): Request {
        expect(fetchMock).toHaveBeenCalledTimes(1);
        return fetchMock.mock.calls[0]![0] as Request;
    }

    it("builds the right URL for GET /health", async () => {
        const client = createMmoServerClient({ baseUrl: "http://x", fetch: fetchMock as unknown as typeof fetch });

        const { data, error } = await client.GET("/health");

        expect(request().url).toBe("http://x/health");
        expect(request().method).toBe("GET");
        expect(error).toBeUndefined();
        expect(data?.status).toBe("ok");
    });

    it("strips trailing slashes from the base URL", async () => {
        const client = createMmoServerClient({ baseUrl: "http://x:17899//", fetch: fetchMock as unknown as typeof fetch });

        await client.GET("/health");

        expect(request().url).toBe("http://x:17899/health");
    });

    it("sends the device token and user id as headers", async () => {
        const client = createMmoServerClient({
            baseUrl: "http://x",
            token: "tok",
            userId: "u1",
            fetch: fetchMock as unknown as typeof fetch,
        });

        await client.GET("/health");

        expect(request().headers.get("x-device-token")).toBe("tok");
        expect(request().headers.get("x-user-id")).toBe("u1");
    });

    it("expands path and query parameters", async () => {
        const client = createMmoServerClient({ baseUrl: "http://x", fetch: fetchMock as unknown as typeof fetch });

        await client.GET("/video/file/{fileId}/info", { params: { path: { fileId: "abc" } } });

        expect(request().url).toBe("http://x/video/file/abc/info");
    });
});
