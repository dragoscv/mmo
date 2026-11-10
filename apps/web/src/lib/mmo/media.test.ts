import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaClient } from "./media";
import type { Profile } from "./media-types";
import { ProfilesClient } from "./profiles";

const KID = "p_kid 1/ă";
const cfg = { baseUrl: "https://server.test", token: "t", userId: "u", scope: "server.test" };

/** Records every requested URL and answers like an MMO Server with an empty library. */
function stubServer(): URL[] {
    const seen: URL[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
        const url = new URL(String(input));
        seen.push(url);
        const body = url.pathname === "/media/etag"
            ? { revision: 1, libraryEtag: 1 }
            : url.pathname === "/media/search"
                ? { page: 1, totalPages: 1, results: [] }
                : { revision: 1, full: true, items: [], removed: [], serverId: null, serverName: "s" };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    return seen;
}

function clientFor(profileId: string): MediaClient {
    const profiles = new ProfilesClient(cfg);
    profiles.select({ id: profileId, name: "Kid", hasPin: false, sort: 0, createdAt: 0 } as unknown as Profile);
    return new MediaClient(cfg, profiles);
}

describe("MediaClient sends the active profile", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("on search, so a kid profile is filtered by its age limit", async () => {
        const seen = stubServer();
        await clientFor(KID).mediaSearch("cosmos laundromat");
        const search = seen.find((u) => u.pathname === "/media/search");
        expect(search?.searchParams.get("profile")).toBe(KID);
        expect(search?.searchParams.get("q")).toBe("cosmos laundromat");
        expect(search?.search).toContain("profile=p_kid%201%2F%C4%83");
    });

    it("on the library index (server 3.15+ returns only what the profile may watch)", async () => {
        const seen = stubServer();
        await clientFor(KID).mediaLibrary();
        const library = seen.find((u) => u.pathname === "/media/library");
        expect(library?.searchParams.get("profile")).toBe(KID);
    });

    it("keeps one cached library per profile", async () => {
        const seen = stubServer();
        const profiles = new ProfilesClient(cfg);
        const media = new MediaClient(cfg, profiles);
        profiles.select({ id: "default", name: "Adult", hasPin: false, sort: 0, createdAt: 0 } as unknown as Profile);
        await media.mediaLibrary();
        await media.mediaLibrary();
        profiles.select({ id: KID, name: "Kid", hasPin: false, sort: 1, createdAt: 0 } as unknown as Profile);
        await media.mediaLibrary();
        const asked = seen.filter((u) => u.pathname === "/media/library").map((u) => u.searchParams.get("profile"));
        expect(asked).toEqual(["default", KID]);
    });
});
