import { describe, expect, it } from "vitest";
import type { LiveTvSource } from "@/lib/mmo/media-types";
import { emptySourceForm, formFromSource, toSourceInput, validateSourceForm } from "./source-form";

const src: LiveTvSource = {
    id: "s1", kind: "xtream", name: "Prov", url: "http://p.example:8080", xmltvUrl: null, username: "u1", hasPassword: true,
    enabled: true, refreshHours: 12, channelCount: 10, tunerLimit: 2, createdAt: 1, updatedAt: 1,
};

describe("source form", () => {
    it("new m3u source sends kind, trims, nulls an empty XMLTV and omits credentials", () => {
        const f = { ...emptySourceForm(), name: "  TV  ", url: " http://x/list.m3u " };
        expect(validateSourceForm(f)).toEqual([]);
        expect(toSourceInput(f)).toEqual({ kind: "m3u", name: "TV", url: "http://x/list.m3u", enabled: true, refreshHours: 24, xmltvUrl: null });
    });

    it("editing keeps the stored password when the field is empty and never sends kind", () => {
        const f = formFromSource(src);
        expect(f.password).toBe("");
        expect(validateSourceForm(f)).toEqual([]);
        const body = toSourceInput(f);
        expect(body.kind).toBeUndefined();
        expect("password" in body).toBe(false);
        expect(body).toMatchObject({ username: "u1", tunerLimit: 2, refreshHours: 12 });
        expect(toSourceInput({ ...f, password: "new" }).password).toBe("new");
    });

    it("hdhomerun never sends xmltv or credentials", () => {
        const body = toSourceInput({ ...emptySourceForm(), kind: "hdhomerun", name: "Tuner", url: "192.168.1.50", xmltvUrl: "x", username: "a" });
        expect(body).not.toHaveProperty("xmltvUrl");
        expect(body).not.toHaveProperty("username");
    });

    it("mirrors the server validation rules", () => {
        const f = { ...emptySourceForm(), kind: "xtream" as const, refreshHours: "0", tunerLimit: "99" };
        expect(validateSourceForm(f)).toEqual(["name", "url", "username", "password", "refreshHours", "tunerLimit"]);
        expect(validateSourceForm({ ...emptySourceForm(), name: "a", url: "b", refreshHours: "1.5" })).toEqual(["refreshHours"]);
    });
});
