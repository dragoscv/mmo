import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.join(os.tmpdir(), "rbanlz");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const src = path.join(root, "a.mp3");
fs.writeFileSync(src, Buffer.alloc(8192, 7));
const dest = path.join(root, "USB");

const preview = Array.from({ length: 400 }, (_, i) => i % 256);
const detail = Array.from({ length: 2000 }, (_, i) => (i * 7) % 256);
const beats = [];
for (let i = 0; i < 32; i++) beats.push({ position_ms: i * 469, beat_number: (i % 4) + 1, bpm: 128 });

const manifest = {
  destination: dest,
  options: { write_pdb: false, write_ext: false, write_anlz: true, auto_cue: true, transcode: "none" },
  tracks: [{ id: 5, source_path: src, title: "T", artist: "A", album: "B", bpm: 128, duration_sec: 200,
    beats, cues: [{ position_ms: 1000, is_hot: true, hot_index: 0, label: "A" }],
    waveform_preview: preview, waveform_detail: detail }],
  playlists: [],
};
const bin = path.join("target", "release", process.platform === "win32" ? "rbexport.exe" : "rbexport");
console.log(execFileSync(bin, [], { input: JSON.stringify(manifest) }).toString().trim());

// find the DAT
function findDat(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findDat(p); if (r) return r; }
    else if (e.name === "ANLZ0000.DAT") return p;
  }
  return null;
}
const dat = findDat(path.join(dest, "PIONEER", "USBANLZ"));
console.log("DAT:", dat, fs.statSync(dat).size, "bytes");
