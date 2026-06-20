// Decode ANLZ (.DAT/.EXT) section tags. Reference: Deep-Symmetry analysis.
import fs from "node:fs";
const buf = fs.readFileSync(process.argv[2]);
// All ANLZ integers are BIG-endian.
const u32 = (o) => buf.readUInt32BE(o);
const tag4 = (o) => buf.subarray(o, o + 4).toString("latin1");

if (tag4(0) !== "PMAI") {
  console.error("not a PMAI file, got", JSON.stringify(tag4(0)));
  process.exit(1);
}
const fileLenHeader = u32(4);
const fileLen = u32(8);
console.log(`PMAI header: lenHeader=${fileLenHeader} lenFile=${fileLen} (actual ${buf.length})`);

let o = fileLenHeader; // sections start after the file header
while (o + 12 <= buf.length) {
  const tag = tag4(o);
  if (!/^[A-Z0-9]{4}$/.test(tag)) {
    console.log(`@${o}: stop (non-tag bytes ${JSON.stringify(tag)})`);
    break;
  }
  const lenHeader = u32(o + 4);
  const lenTag = u32(o + 8);
  console.log(`\n@${o} ${tag}  lenHeader=${lenHeader} lenTag=${lenTag}`);
  // Show a small body preview + a few interpreted fields.
  const bodyStart = o + 12;
  const preview = buf.subarray(o + 12, Math.min(o + 12 + 32, o + lenTag));
  console.log(`   bytes@12: ${preview.toString("hex").replace(/(..)/g, "$1 ").trim()}`);
  // tag-specific
  if (tag === "PPTH") {
    const len = u32(o + 12);
    const s = buf.subarray(o + 16, o + 16 + len - 2).swap16().toString("utf16le");
    console.log(`   PPTH path len=${len} : ${JSON.stringify(s)}`);
  } else if (tag === "PQTZ") {
    const u1 = u32(o + 12), u2 = u32(o + 16), count = u32(o + 20);
    console.log(`   PQTZ u1=${u1} u2=0x${u2.toString(16)} beats=${count} (entry stride ${(lenTag - 24) / Math.max(count,1)})`);
    for (let i = 0; i < Math.min(3, count); i++) {
      const e = o + 24 + i * 8;
      console.log(`     beat[${i}] num=${buf.readUInt16BE(e)} tempo=${buf.readUInt16BE(e + 2)} time=${u32(e + 4)}`);
    }
  } else if (tag === "PCOB" || tag === "PCO2") {
    const type = u32(o + 12);
    const count = buf.readUInt16BE(o + 18);
    console.log(`   ${tag} type=${type} count=${count}`);
  } else if (tag.startsWith("PWV") || tag === "PWAV") {
    const lenEntry = u32(o + 12);
    const entries = u32(o + 16);
    console.log(`   ${tag} lenEntryBytes=${lenEntry} entries=${entries}`);
  } else if (tag === "PVBR") {
    console.log(`   PVBR (vbr index)`);
  }
  if (lenTag <= 0) { console.log("   lenTag 0, stop"); break; }
  o += lenTag;
}
