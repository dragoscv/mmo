// Decode a single track row per crate-digger rekordbox_pdb.ksy track row.
import fs from "node:fs";
const buf = fs.readFileSync(process.argv[2] || "reference/export.pdb");
const PAGE = 4096;
const u8 = (o) => buf.readUInt8(o);
const u16 = (o) => buf.readUInt16LE(o);
const u32 = (o) => buf.readUInt32LE(o);

// tracks table: page 2 (from prior decode), first row @552.
const page = parseInt(process.argv[3] || "2", 10);
const rowOff = parseInt(process.argv[4] || "552", 10);
const base = page * PAGE + rowOff;

// crate-digger track row fixed fields:
const f = {};
let o = base;
f.u1 = u16(o); o += 2;                 // 0x00
f.index_shift = u16(o); o += 2;        // 0x02
f.bitmask = u32(o); o += 4;            // 0x04
f.sample_rate = u32(o); o += 4;        // 0x08
f.composer_id = u32(o); o += 4;        // 0x0c
f.file_size = u32(o); o += 4;          // 0x10
f.u2 = u32(o); o += 4;                 // 0x14
f.u3 = u16(o); o += 2;                 // 0x18
f.u4 = u16(o); o += 2;                 // 0x1a
f.artwork_id = u32(o); o += 4;         // 0x1c
f.key_id = u32(o); o += 4;             // 0x20
f.orig_artist_id = u32(o); o += 4;     // 0x24
f.label_id = u32(o); o += 4;           // 0x28
f.remixer_id = u32(o); o += 4;         // 0x2c
f.bitrate = u32(o); o += 4;            // 0x30
f.track_number = u32(o); o += 4;       // 0x34
f.tempo = u32(o); o += 4;              // 0x38 (bpm*100)
f.genre_id = u32(o); o += 4;           // 0x3c
f.album_id = u32(o); o += 4;           // 0x40
f.artist_id = u32(o); o += 4;          // 0x44
f.id = u32(o); o += 4;                 // 0x48
f.disc = u16(o); o += 2;               // 0x4c
f.play_count = u16(o); o += 2;         // 0x4e
f.year = u16(o); o += 2;               // 0x50
f.sample_depth = u16(o); o += 2;       // 0x52
f.duration = u16(o); o += 2;           // 0x54
f.u5 = u16(o); o += 2;                 // 0x56
f.color_id = u8(o); o += 1;            // 0x58
f.rating = u8(o); o += 1;              // 0x59
f.u6 = u16(o); o += 2;                 // 0x5a
f.u7 = u16(o); o += 2;                 // 0x5c
// then 21 string offsets (u16 each), relative to row start
const strOffBase = o;
const strOffsets = [];
for (let i = 0; i < 21; i++) { strOffsets.push(u16(o)); o += 2; }
console.log("fixed fields:", JSON.stringify(f, null, 0));
console.log("strOffsetTable starts @", strOffBase - base, "offsets:", strOffsets.join(","));

// Decode each string (DeviceSQL short/long)
function readDevString(abs) {
  const flag = u8(abs);
  if (flag & 1) {
    const len = (flag >> 1) - 1;
    return buf.subarray(abs + 1, abs + 1 + len).toString("latin1");
  }
  // long: 0x40 short header? 0x90 utf16
  if (flag === 0x90) {
    const len = u16(abs + 1);
    const body = buf.subarray(abs + 4, abs + len);
    return Buffer.from(body).toString("utf16le");
  }
  if (flag === 0x40) {
    const len = u16(abs + 1);
    return buf.subarray(abs + 4, abs + len).toString("latin1");
  }
  return `<flag=0x${flag.toString(16)}>`;
}
const labels = ["isrc","texter","unk1","unk2","unk3","unk4","message","kuvo","unk5","autoload","unk6","label?","unk7","analyze_path","analyze_date","comment","title","unk8","filename","file_path","unk9"];
strOffsets.forEach((so, i) => {
  if (so === 0) return;
  const s = readDevString(base + so);
  console.log(`  str[${i}] (${labels[i] || "?"}) @${so}: ${JSON.stringify(s)}`);
});
