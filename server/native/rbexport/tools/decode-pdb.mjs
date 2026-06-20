// Decode a rekordbox export.pdb to understand exact byte layout.
// Usage: node decode-pdb.mjs <path-to.pdb> [maxRowsPerTable]
import fs from "node:fs";

const path = process.argv[2];
const maxRows = parseInt(process.argv[3] || "3", 10);
const buf = fs.readFileSync(path);

const PAGE = 4096;
const u32 = (o) => buf.readUInt32LE(o);
const u16 = (o) => buf.readUInt16LE(o);
const u8 = (o) => buf.readUInt8(o);

// ── File header (page 0) ─────────────────────────────────────────────
console.log("=== FILE HEADER ===");
console.log("gap0      :", u32(0x00));
console.log("len_page  :", u32(0x04));
console.log("num_tables:", u32(0x08));
console.log("next_unuse:", u32(0x0c));
console.log("unknown   :", u32(0x10));
console.log("sequence  :", u32(0x14));
console.log("gap1c     :", u32(0x18));

const TABLE_NAMES = {
  0: "tracks", 1: "genres", 2: "artists", 3: "albums", 4: "labels",
  5: "keys", 6: "colors", 7: "playlist_tree", 8: "playlist_entries",
  9: "unknown9", 10: "unknown10", 11: "unknown11", 12: "unknown12",
  13: "artwork", 14: "unknown14", 15: "unknown15", 16: "columns",
  17: "history_playlists", 18: "history_entries", 19: "history",
};

const numTables = u32(0x08);
const tables = [];
let off = 0x1c;
for (let i = 0; i < numTables; i++) {
  const type = u32(off);
  const empty = u32(off + 4);
  const first = u32(off + 8);
  const last = u32(off + 12);
  tables.push({ type, empty, first, last });
  off += 16;
}
console.log("\n=== TABLES ===");
for (const t of tables) {
  console.log(
    `type=${String(t.type).padStart(2)} ${(TABLE_NAMES[t.type] || "?").padEnd(18)} firstPage=${t.first} lastPage=${t.last} empty=${t.empty}`
  );
}

// ── Page decoder ─────────────────────────────────────────────────────
function decodePage(pageIdx) {
  const base = pageIdx * PAGE;
  const hdr = {
    gap: u32(base + 0x00),
    pageIndex: u32(base + 0x04),
    type: u32(base + 0x08),
    nextPage: u32(base + 0x0c),
    u10: u32(base + 0x10),
    // crate-digger Page header (heap starts at 0x28):
    u14: u32(base + 0x14),
    numRowsSmall: u8(base + 0x18),
    u19: u8(base + 0x19),
    u1a: u8(base + 0x1a),
    pageFlags: u8(base + 0x1b),
    freeSize: u16(base + 0x1c),
    usedSize: u16(base + 0x1e),
    u20: u16(base + 0x20),
    numRowsLarge: u16(base + 0x22),
    u24: u16(base + 0x24),
    u26: u16(base + 0x26),
  };
  return { base, hdr };
}

// Decode row index for a page: groups of 16, each group has offsets then a
// presence bitmask. crate-digger: row groups counted from page end.
// crate-digger row groups: counted from the page END. Each group covers 16
// rows and is laid out (toward lower addresses) as: [16 × u16 offset] then
// [u16 present_flags] — i.e. flags sits at the HIGHER address (closer to page
// end), offsets precede it. Offsets are relative to the heap start (0x28).
// Group g occupies the bytes ending at (pageEnd - g*34).
function rowOffsets(base, numRows) {
  if (numRows <= 0 || numRows > 2000) return [];
  const offs = [];
  const groups = Math.ceil(numRows / 16);
  const pageEnd = base + PAGE;
  for (let g = 0; g < groups; g++) {
    const groupEnd = pageEnd - g * (17 * 2); // 16 offsets + 1 flags = 34 bytes
    const flags = buf.readUInt16LE(groupEnd - 2);
    const inGroup = Math.min(16, numRows - g * 16);
    for (let r = 0; r < inGroup; r++) {
      // offset for row r is at groupEnd - 4 - r*2 (row0 nearest flags)
      const ofs = buf.readUInt16LE(groupEnd - 4 - r * 2);
      if (flags & (1 << r)) offs.push(base + 0x28 + ofs);
    }
  }
  return offs;
}

console.log("\n=== FIRST DATA PAGE PER TABLE ===");
for (const t of tables.slice(0, 9)) {
  // Walk pages from first..last; show the first page that actually has rows.
  let shown = false;
  for (let pg = t.first; pg <= t.last && !shown; pg++) {
    const { base, hdr } = decodePage(pg);
    // crate-digger: use num_rows_large when small == 0x1fff, else small.
    const nrows = hdr.numRowsSmall === 0x1fff ? hdr.numRowsLarge : hdr.numRowsSmall;
    if (nrows === 0 || nrows > 2000) continue;
    shown = true;
  console.log(
    `\n-- ${TABLE_NAMES[t.type] || t.type} page=${pg} flags=0x${hdr.pageFlags.toString(16)} rowsSmall=${hdr.numRowsSmall} rowsLarge=${hdr.numRowsLarge} used=${hdr.usedSize} free=${hdr.freeSize} next=${hdr.nextPage}`
  );
  const offs = rowOffsets(base, nrows);
  for (let i = 0; i < Math.min(maxRows, offs.length); i++) {
    const start = offs[i];
    const end = i + 1 < offs.length ? offs[i + 1] : base + 0x28 + hdr.usedSize;
    const len = Math.max(0, Math.min(end - start, 120));
    const slice = buf.subarray(start, start + len);
    console.log(`   row[${i}] @${start - base} (${len}b):`, slice.toString("hex").replace(/(..)/g, "$1 ").trim());
  }
  }
}
