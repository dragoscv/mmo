import { describe, it, expect } from "vitest";
import { escapeXml, failedEnvelope, okEnvelope, parseFormat, toJson, toXml } from "./response";

const meta = { serverVersion: "2.0.0" };

describe("subsonic response envelope", () => {
    it("JSON ok envelope has the OpenSubsonic fields", () => {
        const json = JSON.parse(toJson(okEnvelope({ license: { valid: true } }, meta)));
        expect(json["subsonic-response"]).toMatchObject({
            status: "ok", version: "1.16.1", type: "MixAI MMO Server", serverVersion: "2.0.0", openSubsonic: true,
            license: { valid: true },
        });
    });

    it("JSON drops null/undefined values", () => {
        const json = JSON.parse(toJson(okEnvelope({ song: { id: "tr_1", year: undefined, genre: null } }, meta)));
        expect(json["subsonic-response"].song).toEqual({ id: "tr_1" });
    });

    it("failed envelope carries error code + message", () => {
        const json = JSON.parse(toJson(failedEnvelope(40, "Wrong username or password", meta)));
        expect(json["subsonic-response"].status).toBe("failed");
        expect(json["subsonic-response"].error).toEqual({ code: 40, message: "Wrong username or password" });
    });

    it("XML: scalars → attributes, arrays → repeated children, value → text", () => {
        const xml = toXml(okEnvelope({
            searchResult3: {
                song: [{ id: "tr_1", title: 'A "quoted" <title> & more' }, { id: "tr_2" }],
            },
            lyricsList: { structuredLyrics: [{ synced: true, line: [{ start: 0, value: "Hello" }] }] },
        }, meta));
        expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><subsonic-response xmlns="http://subsonic.org/restapi" status="ok" version="1.16.1"')).toBe(true);
        expect(xml).toContain('<song id="tr_1" title="A &quot;quoted&quot; &lt;title&gt; &amp; more"/>');
        expect(xml).toContain('<song id="tr_2"/>');
        expect(xml).toContain('<line start="0">Hello</line>');
        expect(xml).toContain('<structuredLyrics synced="true">');
        expect(xml.endsWith("</subsonic-response>")).toBe(true);
    });

    it("XML error element", () => {
        expect(toXml(failedEnvelope(70, "Not found", meta))).toContain('<error code="70" message="Not found"/>');
    });

    it("escapeXml strips control chars", () => {
        expect(escapeXml("a\u0001b'c")).toBe("ab&apos;c");
    });

    it("parseFormat defaults to xml", () => {
        expect(parseFormat(undefined)).toBe("xml");
        expect(parseFormat("JSON")).toBe("json");
        expect(parseFormat("jsonp")).toBe("jsonp");
    });
});
