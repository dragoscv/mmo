import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { decodeEntities, loadXmltv, parseXmltv, parseXmltvTime, XmltvParser, type XmltvProgramme } from "./xmltv";

const DOC = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="test">
  <!-- comment with <programme> inside -->
  <channel id="ProTV.ro">
    <display-name lang="ro">Pro TV</display-name>
    <display-name>PRO TV HD</display-name>
    <icon src="http://logo/pro.png" />
  </channel>
  <programme start="20261104200000 +0200" stop="20261104213000 +0200" channel="ProTV.ro">
    <title lang="ro">Știrile Pro TV</title>
    <sub-title>Ediția de seară</sub-title>
    <desc>Tom &amp; Jerry &lt;3 &quot;live&quot; &#233;&#x21;</desc>
    <category>News</category>
    <episode-num system="xmltv_ns">0.4.</episode-num>
    <episode-num system="onscreen">S01E05</episode-num>
    <icon src="http://img/p.jpg"/>
  </programme>
  <programme start="20261104193000 Z" stop="20261104200000" channel="ProTV.ro">
    <title><![CDATA[Raw & <cdata>]]></title>
  </programme>
  <programme start="20261104210000 -0500" stop="20261104220000 -05:00" channel="Other"><title>Late</title></programme>
  <programme start="bad" channel="ProTV.ro"><title>Ignored</title></programme>
</tv>`;

describe("parseXmltvTime", () => {
    it("converts offsets to epoch ms", () => {
        expect(parseXmltvTime("20261104200000 +0200")).toBe(Date.UTC(2026, 10, 4, 18, 0, 0));
        expect(parseXmltvTime("20261104200000 -05:30")).toBe(Date.UTC(2026, 10, 5, 1, 30, 0));
        expect(parseXmltvTime("20261104200000Z")).toBe(Date.UTC(2026, 10, 4, 20, 0, 0));
        expect(parseXmltvTime("202611042000")).toBe(Date.UTC(2026, 10, 4, 20, 0, 0));
        expect(parseXmltvTime("garbage")).toBeNull();
    });
});

describe("XMLTV parser", () => {
    it("parses channels and programmes with entities, CDATA and episode numbers", () => {
        const { channels, programmes } = parseXmltv(DOC);
        expect(channels).toEqual([{ id: "ProTV.ro", displayNames: ["Pro TV", "PRO TV HD"], icon: "http://logo/pro.png" }]);
        expect(programmes).toHaveLength(3);
        const p = programmes[0]!;
        expect(p).toMatchObject({
            channel: "ProTV.ro", start: Date.UTC(2026, 10, 4, 18), stop: Date.UTC(2026, 10, 4, 19, 30), title: "Știrile Pro TV",
            subtitle: "Ediția de seară", description: 'Tom & Jerry <3 "live" é!', category: "News", episodeNum: "S01E05", icon: "http://img/p.jpg",
        });
        expect(programmes[1]!.title).toBe("Raw & <cdata>");
        expect(programmes[2]).toMatchObject({ channel: "Other", start: Date.UTC(2026, 10, 5, 2), stop: Date.UTC(2026, 10, 5, 3) });
    });

    it("gives identical results when fed one character at a time", () => {
        const all: XmltvProgramme[] = [];
        const p = new XmltvParser({ onProgramme: (x) => all.push(x) });
        for (const ch of DOC) p.feed(ch);
        p.end();
        expect(all).toEqual(parseXmltv(DOC).programmes);
    });

    it("decodeEntities leaves unknown entities untouched", () => {
        expect(decodeEntities("a &unknown; &amp; b")).toBe("a &unknown; & b");
    });

    it("loadXmltv streams gzip bodies detected by magic bytes", async () => {
        const gz = zlib.gzipSync(Buffer.from(DOC, "utf8"));
        let count = 0;
        const res = await loadXmltv("http://epg.test/guide.xml.gz", { onProgramme: () => { count++; } }, {
            fetch: async () => new Response(new Uint8Array(gz)),
        });
        expect(count).toBe(3);
        expect(res).toMatchObject({ channels: 1, programmes: 3, bytes: Buffer.byteLength(DOC) });
    });

    it("handles a large guide in chunks", async () => {
        const parts = ['<?xml version="1.0"?><tv>'];
        for (let i = 0; i < 20000; i++) {
            parts.push(`<programme start="2026110${1 + (i % 9)}${String(i % 24).padStart(2, "0")}0000 +0000" stop="2026110${1 + (i % 9)}${String(i % 24).padStart(2, "0")}3000 +0000" channel="c${i % 50}"><title>Show ${i} &amp; co</title><desc>${"x".repeat(200)}</desc></programme>`);
        }
        parts.push("</tv>");
        const body = Buffer.from(parts.join("\n"));
        let n = 0;
        // Uneven 7777-byte chunks split tags and UTF-8 boundaries.
        const stream = new ReadableStream<Uint8Array>({
            start(c) { for (let i = 0; i < body.length; i += 7777) c.enqueue(new Uint8Array(body.subarray(i, i + 7777))); c.close(); },
        });
        await loadXmltv("http://epg.test/big.xml", { onProgramme: (p) => { if (p.title.endsWith("& co")) n++; } }, {
            fetch: async () => new Response(stream),
        });
        expect(n).toBe(20000);
    });
});
