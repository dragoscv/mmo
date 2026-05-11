import { describe, it, expect } from "vitest";
import { generateRekordboxXml, type RekordboxXmlTrack } from "./rekordbox-xml";

const t = (over: Partial<RekordboxXmlTrack> = {}): RekordboxXmlTrack => ({
    id: 1,
    filepath: "C:\\Music\\track.mp3",
    filename: "track.mp3",
    title: "Track",
    artist: "Artist",
    album: null,
    genre: null,
    keyMusical: null,
    bpm: 128,
    duration: 240,
    bitrate: 320,
    sampleRate: 44100,
    energy: 4,
    mood: null,
    setPosition: null,
    color: null,
    ...over,
});

describe("generateRekordboxXml", () => {
    it("emits a valid XML envelope", () => {
        const xml = generateRekordboxXml([t()]);
        expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
        expect(xml).toContain("<DJ_PLAYLISTS Version=\"1.0.0\">");
        expect(xml).toContain("</DJ_PLAYLISTS>");
        expect(xml).toContain("<COLLECTION Entries=\"1\">");
    });

    it("converts Windows backslashes to forward slashes in Location", () => {
        const xml = generateRekordboxXml([t({ filepath: "C:\\My Music\\song.mp3" })]);
        expect(xml).toContain("Location=\"file://localhost/C:/My%20Music/song.mp3\"");
    });

    it("escapes XML-special characters in title/artist", () => {
        const xml = generateRekordboxXml([
            t({ title: "Rock & Roll", artist: "<DJ> \"Mix\"" }),
        ]);
        expect(xml).toContain("Name=\"Rock &amp; Roll\"");
        expect(xml).toContain("Artist=\"&lt;DJ&gt; &quot;Mix&quot;\"");
    });

    it("formats BPM with 2 decimals", () => {
        const xml = generateRekordboxXml([t({ bpm: 128.5 })]);
        expect(xml).toContain("AverageBpm=\"128.50\"");
    });

    it("maps energy 1..5 to rekordbox rating multiplied by 51", () => {
        const xml = generateRekordboxXml([t({ energy: 4 })]);
        expect(xml).toContain("Rating=\"204\"");
    });

    it("emits playlists with correct entry counts and remapped track ids", () => {
        const tracks = [t({ id: 100 }), t({ id: 200, filename: "b.mp3" })];
        const xml = generateRekordboxXml(tracks, [
            { name: "Set 1", trackIds: [200, 100, 999] }, // 999 is unknown -> dropped
        ]);
        expect(xml).toContain("<NODE Type=\"1\" Name=\"Set 1\" KeyType=\"0\" Entries=\"3\">");
        // Two valid entries remapped (id 200 -> sequential 2, id 100 -> 1)
        expect(xml).toContain("Key=\"2\"");
        expect(xml).toContain("Key=\"1\"");
        // Unknown id 999 not emitted
        expect(xml).not.toContain("Key=\"999\"");
    });

    it("falls back to filename when title is missing", () => {
        const xml = generateRekordboxXml([t({ title: null, filename: "fallback.mp3" })]);
        expect(xml).toContain("Name=\"fallback.mp3\"");
    });
});
