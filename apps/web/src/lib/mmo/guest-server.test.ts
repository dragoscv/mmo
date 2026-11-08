import { describe, expect, it } from "vitest";
import {
    guestConnections, isGuestConnection, needsDesktopProxy, normalizeServerUrl, parseGuestState,
    withActive, withServer, withoutServer, type GuestServer,
} from "./guest-server";

const s = (baseUrl: string, token = "tok"): GuestServer => ({ baseUrl, token, userId: "", name: "", pairedAt: 1 });

describe("normalizeServerUrl", () => {
    it("adds https to public hosts and drops paths", () => {
        expect(normalizeServerUrl("demo.mixai.ro")).toBe("https://demo.mixai.ro");
        expect(normalizeServerUrl("  https://demo.mixai.ro/media/music?x=1 ")).toBe("https://demo.mixai.ro");
        expect(normalizeServerUrl("https://34-118-46-71.nip.io/")).toBe("https://34-118-46-71.nip.io");
    });
    it("keeps LAN hosts on http with the default port", () => {
        expect(normalizeServerUrl("192.168.1.10")).toBe("http://192.168.1.10:17899");
        expect(normalizeServerUrl("192.168.1.10:18000")).toBe("http://192.168.1.10:18000");
        expect(normalizeServerUrl("nas.local")).toBe("http://nas.local:17899");
        expect(normalizeServerUrl("http://localhost:17899")).toBe("http://localhost:17899");
    });
    it("rejects garbage, credentials and other schemes", () => {
        expect(normalizeServerUrl("")).toBeNull();
        expect(normalizeServerUrl("ftp://x.ro")).toBeNull();
        expect(normalizeServerUrl("https://u:p@x.ro")).toBeNull();
        expect(normalizeServerUrl("http://")).toBeNull();
    });
});

describe("needsDesktopProxy", () => {
    it("is true only for an http server under an https page", () => {
        expect(needsDesktopProxy("http://192.168.1.10:17899", "https:")).toBe(true);
        expect(needsDesktopProxy("https://demo.mixai.ro", "https:")).toBe(false);
        expect(needsDesktopProxy("http://192.168.1.10:17899", "http:")).toBe(false);
    });
});

describe("guest state", () => {
    it("parses defensively and repairs a dangling active", () => {
        expect(parseGuestState(null)).toEqual({ active: null, servers: [] });
        expect(parseGuestState("{bad")).toEqual({ active: null, servers: [] });
        const st = parseGuestState(JSON.stringify({ active: "https://gone", servers: [s("https://a.ro"), { baseUrl: "https://b.ro", token: "" }] }));
        expect(st.servers.map((x) => x.baseUrl)).toEqual(["https://a.ro"]);
        expect(st.active).toBe("https://a.ro");
        expect(st.servers[0]?.name).toBe("a.ro");
    });
    it("adds (dedup, newest first), switches and removes", () => {
        let st = withServer({ active: null, servers: [] }, s("https://a.ro"));
        st = withServer(st, s("https://b.ro"));
        st = withServer(st, s("https://a.ro", "new"));
        expect(st.servers.map((x) => x.baseUrl)).toEqual(["https://a.ro", "https://b.ro"]);
        expect(st.servers[0]?.token).toBe("new");
        expect(withActive(st, "https://b.ro").active).toBe("https://b.ro");
        expect(withActive(st, "https://nope").active).toBe("https://a.ro");
        const rm = withoutServer(st, "https://a.ro");
        expect(rm.active).toBe("https://b.ro");
        expect(withoutServer(rm, "https://b.ro")).toEqual({ active: null, servers: [] });
    });
    it("maps to connections with the active server first and a guest: id", () => {
        const st = withActive(withServer(withServer({ active: null, servers: [] }, s("https://a.ro")), s("https://b.ro")), "https://a.ro");
        const c = guestConnections(st);
        expect(c.map((x) => x.baseUrl)).toEqual(["https://a.ro", "https://b.ro"]);
        expect(c[0]?.deviceId).toBe("guest:a.ro");
        expect(c.every((x) => x.online && isGuestConnection(x))).toBe(true);
        expect(isGuestConnection({ deviceId: "8f2c-uuid" })).toBe(false);
    });
});
