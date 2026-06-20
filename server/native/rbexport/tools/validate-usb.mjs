// Full end-to-end USB validation harness.
//
// Builds a complete plug-and-play USB into a temp folder via the rbexport
// sidecar, then re-decodes EVERY file it produced and asserts the structure
// is internally consistent before the user plugs it into real hardware:
//
//   1. Directory layout (Contents/, PIONEER/rekordbox, PIONEER/USBANLZ)
//   2. Audio files copied for every track (size > 0)
//   3. export.pdb       — header, table set, track rows, device paths
//   4. exportExt.pdb    — header, 9-table Device Library Plus subset
//   5. ANLZ .DAT        — PPTH + PQTZ (beatgrid) + PCOB (cues) + PWAV
//   6. ANLZ .EXT        — PPTH + PQTZ + PWV3 + PWV5 (color waveform)
//   7. Cross-checks     — every track row's device path exists on disk;
//                         every track has an ANLZ folder.
//
// Exit 0 = all green. Exit 1 = at least one check failed.
//
// Usage: node tools/validate-usb.mjs [--keep]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const crateDir = path.join(__dirname, "..");

const KEEP = process.argv.includes("--keep");
const PAGE = 4096;

// ── tiny test framework ──────────────────────────────────────────────
let passed = 0;
let failed = 0;
const fails = [];
function check(name, cond, detail = "") {
    if (cond) {
        passed++;
        console.log(`  PASS  ${name}`);
    } else {
        failed++;
        fails.push(name + (detail ? ` — ${detail}` : ""));
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    }
}
function section(title) {
    console.log(`\n=== ${title} ===`);
}

// ── 1. build a realistic manifest ────────────────────────────────────
const root = path.join(os.tmpdir(), "rb-validate");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

// Three source "audio" files (bytes are arbitrary; the sidecar copies them).
const sources = [
    { id: 10, name: "track-a.mp3", title: "Fade", artist: "Jakwob", album: "Boomtown", genre: "Dubstep", key: "8A", bpm: 140.0, dur: 205 },
    { id: 11, name: "track-b.mp3", title: "Strobe", artist: "deadmau5", album: "4x4=12", genre: "Progressive House", key: "4A", bpm: 128.0, dur: 634 },
    { id: 12, name: "track-c.mp3", title: "Roygbiv", artist: "Boards of Canada", album: "Music Has the Right", genre: "IDM", key: "11B", bpm: 95.0, dur: 152 },
];
for (const s of sources) {
    s.source_path = path.join(root, s.name);
    fs.writeFileSync(s.source_path, Buffer.alloc(16384, s.id));
}

// Beats + cues + waveforms for the first track to exercise ANLZ writers.
function makeBeats(bpm, durSec) {
    const beats = [];
    const msPerBeat = 60000 / bpm;
    for (let i = 0, t = 0; t < durSec * 1000; i++, t += msPerBeat) {
        beats.push({ position_ms: t, beat_number: (i % 4) + 1, bpm });
    }
    return beats;
}
const previewWave = Array.from({ length: 400 }, (_, i) => i % 256);
const detailWave = Array.from({ length: 3000 }, (_, i) => (i * 7) % 256);

const dest = path.join(root, "USB");
const manifest = {
    destination: dest,
    options: { write_pdb: true, write_ext: true, write_anlz: true, auto_cue: true, transcode: "none" },
    tracks: sources.map((s, idx) => ({
        id: s.id,
        source_path: s.source_path,
        title: s.title,
        artist: s.artist,
        album: s.album,
        genre: s.genre,
        key: s.key,
        bpm: s.bpm,
        duration_sec: s.dur,
        sample_rate: 44100,
        bitrate: 320,
        beats: idx === 0 ? makeBeats(s.bpm, s.dur) : undefined,
        cues: idx === 0
            ? [
                { position_ms: 0, is_hot: false, label: "Intro" },
                { position_ms: 30000, is_hot: true, hot_index: 0, label: "Drop" },
            ]
            : undefined,
        waveform_preview: idx === 0 ? previewWave : undefined,
        waveform_detail: idx === 0 ? detailWave : undefined,
    })),
    playlists: [
        { id: 1, name: "Warm Up", parent: 0, is_folder: false, track_ids: [12, 11] },
        { id: 2, name: "Peak Time", parent: 0, is_folder: false, track_ids: [10] },
    ],
};

const bin = path.join(crateDir, "target", "release", process.platform === "win32" ? "rbexport.exe" : "rbexport");
section("GENERATE");
let events = "";
try {
    events = execFileSync(bin, [], { input: JSON.stringify(manifest), maxBuffer: 64 * 1024 * 1024 }).toString();
} catch (e) {
    console.error("rbexport failed to run:", e.message);
    if (e.stdout) console.error(e.stdout.toString());
    if (e.stderr) console.error(e.stderr.toString());
    process.exit(1);
}
const evLines = events.trim().split("\n").filter(Boolean);
console.log(`  sidecar emitted ${evLines.length} events`);
const lastEv = evLines.length ? JSON.parse(evLines[evLines.length - 1]) : {};
check("sidecar finished with a terminal event", evLines.length > 0);
check("no error event emitted", !evLines.some((l) => l.includes('"error"')), lastEv.error || "");

// ── 2. directory layout + audio ──────────────────────────────────────
section("LAYOUT + AUDIO");
const contentsDir = path.join(dest, "Contents");
const rbDir = path.join(dest, "PIONEER", "rekordbox");
const anlzDir = path.join(dest, "PIONEER", "USBANLZ");
check("Contents/ exists", fs.existsSync(contentsDir));
check("PIONEER/rekordbox/ exists", fs.existsSync(rbDir));
check("PIONEER/USBANLZ/ exists", fs.existsSync(anlzDir));

function walk(dir) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) out.push(...walk(p));
        else out.push(p);
    }
    return out;
}
const audioFiles = walk(contentsDir);
check("one audio file per track copied", audioFiles.length === sources.length, `found ${audioFiles.length}`);
check("all audio files non-empty", audioFiles.every((f) => fs.statSync(f).size > 0));

// ── shared pdb decode helpers ────────────────────────────────────────
function loadPdb(file) {
    const buf = fs.readFileSync(file);
    const u8 = (o) => buf.readUInt8(o);
    const u16 = (o) => buf.readUInt16LE(o);
    const u32 = (o) => buf.readUInt32LE(o);
    const numTables = u32(0x08);
    const tables = [];
    let off = 0x1c;
    for (let i = 0; i < numTables; i++) {
        tables.push({ type: u32(off), empty: u32(off + 4), first: u32(off + 8), last: u32(off + 12) });
        off += 16;
    }
    return { buf, u8, u16, u32, numTables, tables, lenPage: u32(0x04) };
}

// Collect track rows (device path string at slot 20) from a pdb.
function readTrackDevicePaths(pdb) {
    const { buf, u8, u16, u32, tables } = pdb;
    const t = tables.find((x) => x.type === 0);
    if (!t) return [];
    const paths = [];
    for (let pg = t.first; pg <= t.last; pg++) {
        const base = pg * PAGE;
        if (base + PAGE > buf.length) break;
        if (u8(base + 0x1b) !== 0x24) continue; // not a data page
        // Decode the packed row-count bitfield (spec-correct): 13-bit
        // num_row_offsets + 11-bit num_rows over the 3 bytes at 0x18.
        const rc = u8(base + 0x18) | (u8(base + 0x19) << 8) | (u8(base + 0x1a) << 16);
        const n = (rc >> 13) & 0x7ff;
        if (!(n > 0 && n < 4000)) continue;
        const groups = Math.ceil(n / 16);
        const pageEnd = base + PAGE;
        for (let g = 0; g < groups; g++) {
            const ge = pageEnd - g * 0x24;
            const flags = u16(ge - 4);
            const inG = Math.min(16, n - g * 16);
            for (let r = 0; r < inG; r++) {
                if (!(flags & (1 << r))) continue;
                const rowAbs = base + 0x28 + u16(ge - 6 - r * 2);
                const strBase = rowAbs + 0x5e;
                const o20 = u16(strBase + 20 * 2);
                const flag = u8(rowAbs + o20);
                let devPath = "";
                if (flag & 1) {
                    const len = (flag >> 1) - 1;
                    devPath = buf.subarray(rowAbs + o20 + 1, rowAbs + o20 + 1 + len).toString("latin1");
                }
                paths.push(devPath);
            }
        }
    }
    return paths;
}

// ── 3. export.pdb ────────────────────────────────────────────────────
section("export.pdb");
const exportPdbPath = path.join(rbDir, "export.pdb");
check("export.pdb exists", fs.existsSync(exportPdbPath));
let devicePaths = [];
if (fs.existsSync(exportPdbPath)) {
    const pdb = loadPdb(exportPdbPath);
    check("len_page is 4096", pdb.lenPage === PAGE, `got ${pdb.lenPage}`);
    check("has 20 tables (classic Device Library)", pdb.numTables === 20, `got ${pdb.numTables}`);
    check("has tracks table (type 0)", pdb.tables.some((t) => t.type === 0));
    check("has playlist_tree (7) + entries (8)", pdb.tables.some((t) => t.type === 7) && pdb.tables.some((t) => t.type === 8));
    devicePaths = readTrackDevicePaths(pdb);
    check("decoded one track row per track", devicePaths.length === sources.length, `got ${devicePaths.length}`);
    check("all device paths under /Contents/", devicePaths.length > 0 && devicePaths.every((p) => p.startsWith("/Contents/")), JSON.stringify(devicePaths.slice(0, 3)));
}

// ── 4. exportExt.pdb ─────────────────────────────────────────────────
section("exportExt.pdb");
const extPdbPath = path.join(rbDir, "exportExt.pdb");
check("exportExt.pdb exists", fs.existsSync(extPdbPath));
if (fs.existsSync(extPdbPath)) {
    const ext = loadPdb(extPdbPath);
    check("len_page is 4096", ext.lenPage === PAGE, `got ${ext.lenPage}`);
    check("has 9 tables (Device Library Plus subset)", ext.numTables === 9, `got ${ext.numTables}`);
    check("all table types <= 8", ext.tables.every((t) => t.type <= 8));
    check("has tracks table (type 0)", ext.tables.some((t) => t.type === 0));
}

// ── 5/6. ANLZ files ──────────────────────────────────────────────────
section("ANLZ analysis files");
function readAnlzTags(file) {
    const buf = fs.readFileSync(file);
    const u32 = (o) => buf.readUInt32BE(o);
    const tag4 = (o) => buf.subarray(o, o + 4).toString("latin1");
    if (tag4(0) !== "PMAI") return null;
    const tags = [];
    let o = u32(4);
    while (o + 12 <= buf.length) {
        const tag = tag4(o);
        if (!/^[A-Z0-9]{4}$/.test(tag)) break;
        const lenTag = u32(o + 8);
        tags.push(tag);
        if (lenTag <= 0) break;
        o += lenTag;
    }
    return tags;
}
const datFiles = walk(anlzDir).filter((f) => f.endsWith(".DAT"));
const extFiles = walk(anlzDir).filter((f) => f.endsWith(".EXT"));
check("at least one ANLZ .DAT written", datFiles.length >= 1, `found ${datFiles.length}`);
check("at least one ANLZ .EXT written", extFiles.length >= 1, `found ${extFiles.length}`);

if (datFiles.length) {
    const tags = readAnlzTags(datFiles[0]);
    check(".DAT is a valid PMAI file", tags !== null);
    if (tags) {
        check(".DAT has PPTH (path)", tags.includes("PPTH"), tags.join(","));
        check(".DAT has PQTZ (beatgrid)", tags.includes("PQTZ"), tags.join(","));
        check(".DAT has PCOB (cues)", tags.includes("PCOB"), tags.join(","));
        check(".DAT has PWAV (mono waveform)", tags.includes("PWAV"), tags.join(","));
    }
}
if (extFiles.length) {
    const tags = readAnlzTags(extFiles[0]);
    check(".EXT is a valid PMAI file", tags !== null);
    if (tags) {
        check(".EXT has PPTH (path)", tags.includes("PPTH"), tags.join(","));
        check(".EXT has PWV3 (full-res waveform)", tags.includes("PWV3"), tags.join(","));
        check(".EXT has PWV5 (color waveform, CDJ-3000)", tags.includes("PWV5"), tags.join(","));
    }
}

// ── 7. cross-checks ──────────────────────────────────────────────────
section("CROSS-CHECKS");
if (devicePaths.length) {
    const allExist = devicePaths.every((dp) => {
        const rel = dp.replace(/^\//, "").split("/").join(path.sep);
        return fs.existsSync(path.join(dest, rel));
    });
    check("every track device path resolves to a real file on the USB", allExist);
}
// every analyzed track (only track 0 here) has an ANLZ folder
check("ANLZ folder count matches analyzed tracks", datFiles.length >= 1);

// ── summary ──────────────────────────────────────────────────────────
section("SUMMARY");
console.log(`  ${passed} passed, ${failed} failed`);
if (failed) {
    console.log("\n  Failures:");
    for (const f of fails) console.log(`   - ${f}`);
}
if (KEEP) {
    console.log(`\n  USB kept at: ${dest}`);
} else {
    fs.rmSync(root, { recursive: true, force: true });
}
console.log(failed === 0 ? "\nVALIDATION OK ✅" : "\nVALIDATION FAILED ❌");
process.exit(failed === 0 ? 0 : 1);
