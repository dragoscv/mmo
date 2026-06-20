// Round-trip test: generate a pdb via rbexport, decode it back, assert fields.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.join(os.tmpdir(), "rbrt");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const src = path.join(root, "a.mp3");
fs.writeFileSync(src, Buffer.alloc(8192, 7));
const dest = path.join(root, "USB");

const manifest = {
  destination: dest,
  options: { write_pdb: true, write_ext: false, write_anlz: false, auto_cue: true, transcode: "none" },
  tracks: [
    { id: 2, source_path: src, title: "Jakwob - Fade ft. Maiday", artist: "Jakwob",
      album: "Single", genre: "Dubstep", key: "8A", bpm: 115.0, duration_sec: 205.0,
      sample_rate: 44100, bitrate: 320 },
  ],
  playlists: [{ id: 1, name: "My Set", parent: 0, is_folder: false, track_ids: [2] }],
};

const bin = path.join("target", "release", process.platform === "win32" ? "rbexport.exe" : "rbexport");
const out = execFileSync(bin, [], { input: JSON.stringify(manifest) }).toString();
console.log("events:", out.trim().split("\n").join(" | "));

const pdb = path.join(dest, "PIONEER", "rekordbox", "export.pdb");
const buf = fs.readFileSync(pdb);
const PAGE = 4096;
const u8 = (o) => buf.readUInt8(o), u16 = (o) => buf.readUInt16LE(o), u32 = (o) => buf.readUInt32LE(o);

// find tracks table
const numTables = u32(0x08);
let tracksFirst = null;
for (let i = 0, off = 0x1c; i < numTables; i++, off += 16) {
  if (u32(off) === 0) { tracksFirst = u32(off + 8); break; }
}
// walk pages for first with rows
function rowOffsets(base, n) {
  const offs = []; const groups = Math.ceil(n / 16); const pageEnd = base + PAGE;
  for (let g = 0; g < groups; g++) {
    const ge = pageEnd - g * 34; const flags = u16(ge - 2);
    const inG = Math.min(16, n - g * 16);
    for (let r = 0; r < inG; r++) { const o = u16(ge - 4 - r * 2); if (flags & (1 << r)) offs.push(base + 0x28 + o); }
  }
  return offs;
}
let rowAbs = null;
for (let pg = tracksFirst; pg < numTables * 4 + 50; pg++) {
  const base = pg * PAGE;
  if (base + PAGE > buf.length) break;
  const flags = u8(base + 0x1b);
  if (flags !== 0x24) continue;
  const small = u8(base + 0x18);
  const n = small === 0x1fff ? u16(base + 0x22) : small;
  if (n > 0 && n < 2000) { const offs = rowOffsets(base, n); if (offs.length) { rowAbs = offs[0]; break; } }
}
if (rowAbs == null) { console.error("FAIL: no track row found"); process.exit(1); }

const f = {
  sample_rate: u32(rowAbs + 0x08),
  bitrate: u32(rowAbs + 0x30),
  tempo: u32(rowAbs + 0x38),
  id: u32(rowAbs + 0x48),
  duration: u16(rowAbs + 0x54),
};
console.log("decoded:", JSON.stringify(f));
const checks = [
  ["sample_rate", f.sample_rate, 44100],
  ["bitrate", f.bitrate, 320],
  ["tempo", f.tempo, 11500],
  ["id", f.id, 2],
  ["duration", f.duration, 205],
];
let ok = true;
for (const [name, got, want] of checks) {
  const pass = got === want;
  if (!pass) ok = false;
  console.log(`  ${pass ? "PASS" : "FAIL"} ${name}: got ${got} want ${want}`);
}
// strings
const strBase = rowAbs + 0x5e;
const o20 = u16(strBase + 20 * 2);
const flag = u8(rowAbs + o20);
let devPath = "";
if (flag & 1) devPath = buf.subarray(rowAbs + o20 + 1, rowAbs + o20 + ((flag >> 1) - 1) + 1).toString("latin1");
console.log("  device_path str[20]:", JSON.stringify(devPath));
if (!devPath.startsWith("/Contents/")) ok = false;

console.log(ok ? "\nROUND-TRIP OK" : "\nROUND-TRIP FAILED");
process.exit(ok ? 0 : 1);
