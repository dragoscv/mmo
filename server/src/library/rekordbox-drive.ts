/**
 * Rekordbox-on-drive inspection + maintenance.
 *
 * Reads the classic Device Library database (`PIONEER/rekordbox/export.pdb`)
 * on a connected drive to report how many tracks it holds and which library
 * variants are present (classic / Device Library Plus / OneLibrary), and can
 * wipe the rekordbox database so a drive can be re-exported cleanly.
 *
 * SECURITY: callers MUST pass an absolute drive path. Cleaning only ever
 * removes files *inside* `<drive>/PIONEER/rekordbox` and `<drive>/PIONEER/
 * USBANLZ` — never arbitrary paths.
 */

import fs from "node:fs";
import path from "node:path";

const PAGE = 4096;

export interface RekordboxDriveStatus {
    /** Whether a classic Device Library (`export.pdb`) exists. */
    hasClassic: boolean;
    /** Whether Device Library Plus (`exportExt.pdb`) exists. */
    hasDeviceLibraryPlus: boolean;
    /** Whether the encrypted OneLibrary (`exportLibrary.db`) exists. */
    hasOneLibrary: boolean;
    /** Whether a `Contents/` audio tree exists. */
    hasContents: boolean;
    /** Track count parsed from `export.pdb` (0 when absent/unreadable). */
    trackCount: number;
    /** Total bytes of the rekordbox DB + analysis files (not audio). */
    dbBytes: number;
}

function rbDir(drive: string): string {
    return path.join(drive, "PIONEER", "rekordbox");
}
function anlzDir(drive: string): string {
    return path.join(drive, "PIONEER", "USBANLZ");
}

/** Count track rows in an `export.pdb`, using the spec-correct page layout. */
function countTracks(pdbPath: string): number {
    let buf: Buffer;
    try {
        buf = fs.readFileSync(pdbPath);
    } catch {
        return 0;
    }
    if (buf.length < 0x1c + 16) return 0;
    const u8 = (o: number) => buf.readUInt8(o);
    const u16 = (o: number) => buf.readUInt16LE(o);
    const u32 = (o: number) => buf.readUInt32LE(o);
    if (u32(0x04) !== PAGE) return 0; // len_page sanity
    const numTables = u32(0x08);
    let off = 0x1c;
    let tracks: { first: number; last: number } | null = null;
    for (let i = 0; i < numTables && off + 16 <= buf.length; i++) {
        if (u32(off) === 0) tracks = { first: u32(off + 8), last: u32(off + 12) };
        off += 16;
    }
    if (!tracks) return 0;
    let count = 0;
    for (let pg = tracks.first; pg <= tracks.last; pg++) {
        const base = pg * PAGE;
        if (base + PAGE > buf.length) break;
        if (u8(base + 0x1b) !== 0x24) continue; // data page only
        const rc = u8(base + 0x18) | (u8(base + 0x19) << 8) | (u8(base + 0x1a) << 16);
        const n = (rc >> 13) & 0x7ff;
        if (n > 0 && n < 4000) count += n;
    }
    return count;
}

function dirBytes(dir: string): number {
    let total = 0;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        try {
            if (e.isDirectory()) total += dirBytes(p);
            else total += fs.statSync(p).size;
        } catch {
            // ignore unreadable entries
        }
    }
    return total;
}

/** Inspect the rekordbox library state on a connected drive. */
export function inspectRekordboxDrive(drive: string): RekordboxDriveStatus {
    if (!path.isAbsolute(drive)) {
        throw new Error("drive must be an absolute path");
    }
    const rk = rbDir(drive);
    const classic = path.join(rk, "export.pdb");
    const ext = path.join(rk, "exportExt.pdb");
    const one = path.join(rk, "exportLibrary.db");
    const hasClassic = fs.existsSync(classic);
    return {
        hasClassic,
        hasDeviceLibraryPlus: fs.existsSync(ext),
        hasOneLibrary: fs.existsSync(one),
        hasContents: fs.existsSync(path.join(drive, "Contents")),
        trackCount: hasClassic ? countTracks(classic) : 0,
        dbBytes: dirBytes(rk) + dirBytes(anlzDir(drive)),
    };
}

export interface CleanResult {
    removed: string[];
    /** Whether the encrypted OneLibrary file was removed. */
    removedOneLibrary: boolean;
}

/**
 * Remove the rekordbox database + analysis files from a drive so it can be
 * re-exported cleanly. Audio under `Contents/` is left untouched unless
 * `includeContents` is set.
 *
 * @param includeOneLibrary also delete the encrypted `exportLibrary.db`.
 * @param includeContents   also delete the `Contents/` audio tree.
 */
export function cleanRekordboxDrive(
    drive: string,
    opts: { includeOneLibrary?: boolean; includeContents?: boolean } = {},
): CleanResult {
    if (!path.isAbsolute(drive)) {
        throw new Error("drive must be an absolute path");
    }
    const removed: string[] = [];
    let removedOneLibrary = false;

    const rk = rbDir(drive);
    const oneLib = path.join(rk, "exportLibrary.db");

    // export.pdb + exportExt.pdb (+ any stray rekordbox files), but keep
    // exportLibrary.db unless explicitly asked.
    if (fs.existsSync(rk)) {
        for (const name of fs.readdirSync(rk)) {
            if (name === "exportLibrary.db" && !opts.includeOneLibrary) continue;
            const p = path.join(rk, name);
            try {
                fs.rmSync(p, { recursive: true, force: true });
                removed.push(p);
                if (name === "exportLibrary.db") removedOneLibrary = true;
            } catch {
                // ignore
            }
        }
    }
    void oneLib;

    // USBANLZ analysis tree.
    const anlz = anlzDir(drive);
    if (fs.existsSync(anlz)) {
        try {
            fs.rmSync(anlz, { recursive: true, force: true });
            removed.push(anlz);
        } catch {
            // ignore
        }
    }

    if (opts.includeContents) {
        const contents = path.join(drive, "Contents");
        if (fs.existsSync(contents)) {
            try {
                fs.rmSync(contents, { recursive: true, force: true });
                removed.push(contents);
            } catch {
                // ignore
            }
        }
    }

    return { removed, removedOneLibrary };
}
