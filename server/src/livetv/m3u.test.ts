import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadM3u, parseAttrs, parseM3u } from "./m3u";

const SAMPLE = [
    '\ufeff#EXTM3U x-tvg-url="http://epg.test/guide.xml.gz,http://epg.test/b.xml" catchup="shift"',
    '#EXTINF:-1 tvg-id="ProTV.ro" tvg-name="Pro TV" tvg-logo="http://l/pro.png" tvg-chno="1" group-title="General, RO" catchup="default" catchup-days="3" catchup-source="http://cdn/pro?utc={utc}&d={duration}",Pro TV HD',
    "http://stream.test/pro.m3u8",
    "",
    "#EXTINF:-1 tvg-id=Digi24.ro group-title=News,Digi 24",
    "#EXTVLCOPT:http-user-agent=Foo",
    "http://stream.test/digi.ts",
    "#EXTINF:0,Antena 3",
    "#EXTGRP:Știri",
    "http://stream.test/a3.ts",
    "http://orphan.test/no-extinf.ts",
].join("\r\n");

describe("parseM3u", () => {
    it("reads header xmltv url, attributes, groups and names", () => {
        const pl = parseM3u(SAMPLE);
        expect(pl.xmltvUrl).toBe("http://epg.test/guide.xml.gz");
        expect(pl.entries).toHaveLength(3);
        const [pro, digi, a3] = pl.entries;
        expect(pro).toMatchObject({
            name: "Pro TV HD", url: "http://stream.test/pro.m3u8", tvgId: "ProTV.ro", tvgName: "Pro TV", tvgLogo: "http://l/pro.png",
            tvgChno: "1", groupTitle: "General, RO", catchup: "default", catchupDays: 3, catchupSource: "http://cdn/pro?utc={utc}&d={duration}",
        });
        expect(digi).toMatchObject({ name: "Digi 24", tvgId: "Digi24.ro", groupTitle: "News", url: "http://stream.test/digi.ts" });
        expect(a3).toMatchObject({ name: "Antena 3", groupTitle: "Știri", tvgId: null, duration: 0 });
    });

    it("handles LF-only, CR-only and single-quoted values", () => {
        const lf = parseM3u("#EXTM3U url-tvg='http://x/e.xml'\n#EXTINF:-1 tvg-id='a',A\nhttp://a\n");
        expect(lf.xmltvUrl).toBe("http://x/e.xml");
        expect(lf.entries[0]).toMatchObject({ tvgId: "a", name: "A" });
        const cr = parseM3u("#EXTM3U\r#EXTINF:-1,B\rhttp://b\r");
        expect(cr.entries.map((e) => e.url)).toEqual(["http://b"]);
    });

    it("parseAttrs tolerates unterminated quotes", () => {
        expect(parseAttrs('a="1" b=2 c="unterminated')).toEqual({ a: "1", b: "2", c: "unterminated" });
    });

    it("parses 5000 entries in under 200 ms", () => {
        const lines = ["#EXTM3U"];
        for (let i = 0; i < 5000; i++) {
            lines.push(`#EXTINF:-1 tvg-id="ch${i}" tvg-logo="http://logo/${i}.png" group-title="G${i % 20}",Channel ${i}`);
            lines.push(`http://stream.test/${i}.ts`);
        }
        const text = lines.join("\r\n");
        const t0 = performance.now();
        const pl = parseM3u(text);
        const ms = performance.now() - t0;
        expect(pl.entries).toHaveLength(5000);
        expect(pl.entries[4999]).toMatchObject({ tvgId: "ch4999", groupTitle: "G19" });
        expect(ms).toBeLessThan(200);
    });

    it("loadM3u reads local files and URLs", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m3u-"));
        const file = path.join(dir, "list.m3u");
        fs.writeFileSync(file, "#EXTM3U\n#EXTINF:-1,Local\nhttp://local\n");
        expect((await loadM3u(file)).entries[0]?.name).toBe("Local");
        const remote = await loadM3u("http://x/list.m3u", { fetch: async () => new Response("#EXTM3U\n#EXTINF:-1,R\nhttp://r\n") });
        expect(remote.entries[0]?.name).toBe("R");
        await expect(loadM3u("http://x/404", { fetch: async () => new Response("no", { status: 404 }) })).rejects.toThrow("HTTP 404");
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
