/**
 * Rekordbox `export.pdb` — reader-only spike.
 *
 * This module is intentionally minimal: it parses the 24-byte file
 * header of a Pioneer Rekordbox `.pdb` and exposes the page size and
 * table count. It does NOT decode rows, indexes, strings, checksums,
 * or any of the per-table layouts. It exists so that the spike notes
 * in `concept/rekordbox-pdb.md` are paired with type-checked code and
 * a runnable unit test against a known fixture, rather than only prose.
 *
 * Why no writer? See `concept/rekordbox-pdb.md` § "Risk register" and
 * § "Recommended decision" for the full rationale. Short version: the
 * legal posture (Pioneer/AlphaTheta own the format, no published spec),
 * the field's history of silent format drift across firmware bumps,
 * and the cost of a CDJ-class integrity test rig together make a
 * writer an unfavourable trade against the current XML+manual-import
 * UX. This spike concludes "do not ship a writer". The reader stays
 * around as documentation and as a precondition for any future change
 * of mind (e.g. a writer would still need to round-trip through this
 * reader for self-validation).
 *
 * Format reference: https://djl-analysis.deepsymmetry.org/
 * Kaitai schema  : Deep-Symmetry/crate-digger / rekordbox_pdb.ksy
 */

/** Pioneer's default page size. Header always declares it explicitly. */
export const REKORDBOX_PDB_DEFAULT_PAGE_SIZE = 4096;

/**
 * The minimum legal `.pdb` size. The header consumes 0x18 bytes; each
 * table descriptor is 16 bytes. We require at least one table to
 * consider the file structurally meaningful.
 */
export const REKORDBOX_PDB_MIN_SIZE = 0x18 + 16;

/** Parsed header summary. The full table descriptors are not yet decoded. */
export interface RekordboxPdbHeader {
    /** Page size declared by the header, in bytes. */
    pageSize: number;
    /** Number of tables declared by the header. */
    tableCount: number;
    /** "Next unused page" pointer (page index, not byte offset). */
    nextUnusedPage: number;
    /** Sequence / next-chunk counter; the player uses this on writes. */
    sequence: number;
    /**
     * Absolute byte offset where the table descriptor array starts.
     * Always 0x18 in every Rekordbox-produced file we've sampled, but
     * exposed so a future row decoder doesn't have to hardcode it.
     */
    tableDescriptorStart: number;
}

/** Returned shape of a single (undecoded) table descriptor. */
export interface RekordboxPdbTableDescriptor {
    /**
     * Page-type tag. Known values are documented in
     * `concept/rekordbox-pdb.md` (0=tracks, 1=genres, 2=artists, …).
     * We expose the raw uint32 because new firmware versions add
     * unknown table types and we don't want to bake an enum that
     * silently drops them.
     */
    rawType: number;
    /** Index of the first page in this table. */
    firstPage: number;
    /** Index of the last page in this table. */
    lastPage: number;
}

/**
 * Parse the fixed-size header of a `.pdb` buffer.
 *
 * Throws on:
 *   - buffer too small to contain the header
 *   - declared page size that's not a positive multiple of 512 (every
 *     real-world file we've seen is exactly 4096; values outside the
 *     range [512, 65536] are almost certainly a parse mistake)
 *   - table count that would extend past the buffer's end
 */
export function parseRekordboxPdbHeader(buf: Buffer): RekordboxPdbHeader {
    if (buf.length < REKORDBOX_PDB_MIN_SIZE) {
        throw new Error(
            `pdb: buffer too small (${buf.length} bytes, need ≥ ${REKORDBOX_PDB_MIN_SIZE})`,
        );
    }
    // 0x00..0x04 is treated by every reader (incl. crate-digger) as a
    // "magic" zero word — Rekordbox-produced files always have it.
    // We tolerate non-zero magic so that fixture files built by tests
    // don't have to be padded, but real CDJs do not.
    const pageSize = buf.readUInt32LE(0x04);
    if (pageSize < 512 || pageSize > 65536 || pageSize % 512 !== 0) {
        throw new Error(`pdb: implausible page size ${pageSize}`);
    }
    const tableCount = buf.readUInt32LE(0x08);
    if (tableCount === 0 || tableCount > 256) {
        throw new Error(`pdb: implausible table count ${tableCount}`);
    }
    const tableDescriptorStart = 0x18;
    const requiredLen = tableDescriptorStart + tableCount * 16;
    if (buf.length < requiredLen) {
        throw new Error(
            `pdb: buffer (${buf.length} B) too small for ${tableCount} tables`,
        );
    }
    return {
        pageSize,
        tableCount,
        nextUnusedPage: buf.readUInt32LE(0x0c),
        sequence: buf.readUInt32LE(0x10),
        tableDescriptorStart,
    };
}

/** Read the (undecoded) table descriptors that follow the header. */
export function readRekordboxPdbTableDescriptors(
    buf: Buffer,
    header: RekordboxPdbHeader,
): RekordboxPdbTableDescriptor[] {
    const out: RekordboxPdbTableDescriptor[] = [];
    let offset = header.tableDescriptorStart;
    for (let i = 0; i < header.tableCount; i++) {
        out.push({
            rawType: buf.readUInt32LE(offset),
            // The middle uint32 is "always zero" in samples — left as
            // padding by the writer. Not surfaced.
            firstPage: buf.readUInt32LE(offset + 8),
            lastPage: buf.readUInt32LE(offset + 12),
        });
        offset += 16;
    }
    return out;
}

/**
 * Build a *header-only* `.pdb` buffer for the unit test. This is NOT a
 * writer for real usage — it produces a buffer whose row pages are all
 * zeroes and would not be loaded by any CDJ. It exists so the reader
 * has a fixture to round-trip against without checking a real binary
 * `.pdb` into the repository (we don't want sample Pioneer data in git).
 */
export function buildRekordboxPdbHeaderFixture(opts: {
    pageSize?: number;
    tables: { rawType: number; firstPage: number; lastPage: number }[];
}): Buffer {
    const pageSize = opts.pageSize ?? REKORDBOX_PDB_DEFAULT_PAGE_SIZE;
    const tableCount = opts.tables.length;
    if (tableCount === 0) throw new Error("at least one table required");
    const len = 0x18 + tableCount * 16;
    const buf = Buffer.alloc(len);
    buf.writeUInt32LE(0, 0x00); // magic / always zero
    buf.writeUInt32LE(pageSize, 0x04);
    buf.writeUInt32LE(tableCount, 0x08);
    buf.writeUInt32LE(1, 0x0c); // next unused page
    buf.writeUInt32LE(0, 0x10); // sequence
    buf.writeUInt32LE(0, 0x14); // reserved
    let offset = 0x18;
    for (const t of opts.tables) {
        buf.writeUInt32LE(t.rawType, offset);
        buf.writeUInt32LE(0, offset + 4); // padding
        buf.writeUInt32LE(t.firstPage, offset + 8);
        buf.writeUInt32LE(t.lastPage, offset + 12);
        offset += 16;
    }
    return buf;
}
