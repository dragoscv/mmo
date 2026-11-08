import { describe, expect, it } from "vitest";
import type { Profile } from "./media-types";
import { ProfilesClient } from "./profiles";

const prof = (id: string, hasPin = false) => ({ id, name: id, hasPin, sort: 0, createdAt: 0 }) as unknown as Profile;

describe("ProfilesClient.activeUsable", () => {
    const client = () => new ProfilesClient({ baseUrl: "https://demo.mixai.ro", token: "t", userId: "u", scope: "demo.mixai.ro" });

    it("is false before a pick", () => {
        expect(client().activeUsable()).toBe(false);
    });

    it("closes the gate after picking a PIN-less profile even when the server has several", () => {
        const c = client();
        c.select(prof("reviewer"));
        expect(c.activeUsable()).toBe(true);
    });

    it("keeps the gate for a PIN profile without a token", () => {
        const c = client();
        c.select(prof("kids", true));
        expect(c.activeUsable()).toBe(false);
    });
});
