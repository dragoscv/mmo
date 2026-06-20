import { describe, it, expect } from "vitest";
import {
    REKORDBOX_PDB_DEFAULT_PAGE_SIZE,
    buildRekordboxPdbHeaderFixture,
    parseRekordboxPdbHeader,
    readRekordboxPdbTableDescriptors,
} from "./rekordbox-pdb";

describe("rekordbox-pdb (reader-only spike)", () => {
    it("round-trips a multi-table header fixture", () => {
        const buf = buildRekordboxPdbHeaderFixture({
            tables: [
                { rawType: 0, firstPage: 1, lastPage: 8 }, // tracks
                { rawType: 1, firstPage: 9, lastPage: 11 }, // genres
                { rawType: 2, firstPage: 12, lastPage: 20 }, // artists
                { rawType: 7, firstPage: 21, lastPage: 22 }, // playlist tree
            ],
        });
        const header = parseRekordboxPdbHeader(buf);
        expect(header.pageSize).toBe(REKORDBOX_PDB_DEFAULT_PAGE_SIZE);
        expect(header.tableCount).toBe(4);
        expect(header.tableDescriptorStart).toBe(0x1c);

        const tables = readRekordboxPdbTableDescriptors(buf, header);
        expect(tables).toHaveLength(4);
        expect(tables[0]).toEqual({ rawType: 0, firstPage: 1, lastPage: 8 });
        expect(tables[3]).toEqual({ rawType: 7, firstPage: 21, lastPage: 22 });
    });

    it("rejects buffers that are too small for the header", () => {
        expect(() => parseRekordboxPdbHeader(Buffer.alloc(8))).toThrow(/too small/i);
    });

    it("rejects implausible page sizes", () => {
        const buf = buildRekordboxPdbHeaderFixture({
            tables: [{ rawType: 0, firstPage: 0, lastPage: 0 }],
        });
        // overwrite the page size with garbage
        buf.writeUInt32LE(123, 0x04);
        expect(() => parseRekordboxPdbHeader(buf)).toThrow(/page size/i);
    });

    it("rejects implausible table counts", () => {
        const buf = buildRekordboxPdbHeaderFixture({
            tables: [{ rawType: 0, firstPage: 0, lastPage: 0 }],
        });
        buf.writeUInt32LE(9999, 0x08);
        expect(() => parseRekordboxPdbHeader(buf)).toThrow(/table count|too small/i);
    });

    it("rejects a header that promises more tables than the buffer holds", () => {
        const buf = buildRekordboxPdbHeaderFixture({
            tables: [
                { rawType: 0, firstPage: 0, lastPage: 0 },
                { rawType: 1, firstPage: 0, lastPage: 0 },
            ],
        });
        // Lie: declare 32 tables in an 8-byte-of-tables buffer.
        buf.writeUInt32LE(32, 0x08);
        expect(() => parseRekordboxPdbHeader(buf)).toThrow(/too small/i);
    });
});
