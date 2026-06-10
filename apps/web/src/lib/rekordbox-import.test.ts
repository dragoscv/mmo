import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseRekordboxXml } from "./rekordbox-import";

let tmp = "";

function fixture(xml: string): string {
    const p = path.join(tmp, "rb.xml");
    fs.writeFileSync(p, xml, "utf8");
    return p;
}

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-rb-"));
});
afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe("parseRekordboxXml", () => {
    it("returns an explicit error for a missing file", () => {
        const res = parseRekordboxXml(path.join(tmp, "nope.xml"));
        expect(res.tracks).toEqual([]);
        expect(res.errors[0]).toMatch(/File not found/);
    });

    it("flags malformed XML in errors[]", () => {
        const p = fixture("<not closed");
        const res = parseRekordboxXml(p);
        expect(res.tracks).toEqual([]);
        expect(res.errors[0]).toMatch(/XML parse error/);
    });

    it("parses a single track with metadata", () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <COLLECTION Entries="1">
    <TRACK TrackID="42" Name="Sunrise" Artist="DJ Foo" Album="EP1" Genre="Tech House"
           AverageBpm="124.50" TotalTime="305" Tonality="Am" Rating="204"
           Location="file://localhost/C:/Music/track.mp3" BitRate="320" SampleRate="44100" />
  </COLLECTION>
  <PLAYLISTS></PLAYLISTS>
</DJ_PLAYLISTS>`;
        const res = parseRekordboxXml(fixture(xml));
        expect(res.errors).toEqual([]);
        expect(res.tracks).toHaveLength(1);
        const t = res.tracks[0];
        expect(t.rekordboxId).toBe(42);
        expect(t.title).toBe("Sunrise");
        expect(t.artist).toBe("DJ Foo");
        expect(t.bpm).toBe(124.5);
        expect(t.duration).toBe(305);
        expect(t.bitrate).toBe(320);
        expect(t.sampleRate).toBe(44100);
        expect(t.keyMusical).toBe("Am");
        // Rating 204 → 4 stars → energy 4
        expect(t.energy).toBe(4);
        // file://localhost/C:/Music/track.mp3 -> windows path
        expect(t.filepath).toContain("Music");
        expect(t.filename).toBe("track.mp3");
    });

    it("decodes percent-encoded paths", () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS><COLLECTION Entries="1">
  <TRACK TrackID="1" Name="X" Artist="Y" AverageBpm="120" TotalTime="200"
         Location="file://localhost/C:/My%20Music/song%20%26%20remix.mp3" />
</COLLECTION><PLAYLISTS/></DJ_PLAYLISTS>`;
        const res = parseRekordboxXml(fixture(xml));
        expect(res.errors).toEqual([]);
        expect(res.tracks[0].filepath).toContain("My Music");
        expect(res.tracks[0].filename).toBe("song & remix.mp3");
    });

    it("extracts a flat playlist with track ids", () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS>
  <COLLECTION Entries="2">
    <TRACK TrackID="1" Name="A" AverageBpm="120" TotalTime="180" Location="file://localhost/C:/a.mp3" />
    <TRACK TrackID="2" Name="B" AverageBpm="125" TotalTime="200" Location="file://localhost/C:/b.mp3" />
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1">
      <NODE Type="1" Name="Set 1" KeyType="0" Entries="2">
        <TRACK Key="1" />
        <TRACK Key="2" />
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>`;
        const res = parseRekordboxXml(fixture(xml));
        expect(res.errors).toEqual([]);
        expect(res.playlists).toHaveLength(1);
        expect(res.playlists[0].name).toBe("Set 1");
        expect(res.playlists[0].trackIds).toEqual([1, 2]);
    });

    it("extracts nested playlist folders with slash-joined paths", () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS>
  <COLLECTION Entries="1">
    <TRACK TrackID="1" Name="A" AverageBpm="120" TotalTime="180" Location="file://localhost/C:/a.mp3" />
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="1">
      <NODE Type="0" Name="Genres" Count="1">
        <NODE Type="1" Name="Tech House" KeyType="0" Entries="1">
          <TRACK Key="1" />
        </NODE>
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>`;
        const res = parseRekordboxXml(fixture(xml));
        const pl = res.playlists.find((p) => p.name === "Tech House");
        expect(pl).toBeTruthy();
        expect(pl?.path).toBe("Genres/Tech House");
    });

    it("survives mixed bag — some bad tracks, some good", () => {
        // Track without Location should be skipped without aborting the run.
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS>
  <COLLECTION Entries="2">
    <TRACK TrackID="1" Name="OK" AverageBpm="120" TotalTime="180" Location="file://localhost/C:/a.mp3" />
    <TRACK TrackID="2" Name="NoLocation" AverageBpm="120" TotalTime="180" />
  </COLLECTION>
  <PLAYLISTS/>
</DJ_PLAYLISTS>`;
        const res = parseRekordboxXml(fixture(xml));
        expect(res.tracks).toHaveLength(1);
        expect(res.tracks[0].rekordboxId).toBe(1);
    });
});
