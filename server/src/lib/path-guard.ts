/**
 * Path-traversal guard shared by the audio-streaming and download routes.
 *
 * The naive check `normalized.startsWith(scanFolder)` has two well-known
 * holes:
 *
 *   1. **Sibling-path bypass.** If scanFolder is `/srv/music`, the
 *      paths `/srv/music_secret/...` or `/srv/musicXYZ` ALSO pass
 *      `startsWith` because they share the literal prefix. Attacker
 *      with control over the requested URL points at any file in any
 *      directory whose name starts with the same string.
 *
 *   2. **Symlink escape.** A symlink inside the scan folder whose
 *      target is `/etc/passwd` (or any other file) passes the prefix
 *      check because the path itself stays inside the folder. Realpath
 *      resolution catches this.
 *
 * This helper fixes both: it normalises BOTH the requested file and
 * each scan folder, appends a trailing separator before the prefix
 * comparison, and re-checks via `fs.realpathSync` after confirming the
 * file exists. Returns the final on-disk path or null.
 *
 * On Windows we also lowercase both sides because the FS is
 * case-insensitive — without this, `/SRV/Music/x.mp3` would fail an
 * exact prefix check against `/srv/music`.
 */
import path from "node:path";
import fs from "node:fs";

const isWin = process.platform === "win32";
const norm = (p: string): string => isWin ? p.toLowerCase() : p;

export function resolveAllowedFile(
    rawPath: string,
    scanFolders: { path: string }[],
): string | null {
    if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.length > 4096) {
        return null;
    }
    // Reject NUL bytes and other control chars early. Node's fs already
    // rejects NUL but other control chars can confuse downstream tools
    // (logs, antivirus scanners) and have no business in a real path.
    if (/[\x00-\x1F]/.test(rawPath)) return null;

    let resolved: string;
    try { resolved = path.resolve(rawPath); } catch { return null; }
    const resolvedCmp = norm(resolved) + (resolved.endsWith(path.sep) ? "" : path.sep);

    const allowed = scanFolders.some((folder) => {
        const f = path.resolve(folder.path);
        const fCmp = norm(f) + path.sep;
        // Match either the folder itself or anything inside it. The
        // trailing sep on both sides closes the sibling-prefix hole.
        return resolvedCmp === fCmp || (norm(resolved) + path.sep).startsWith(fCmp);
    });
    if (!allowed) return null;

    if (!fs.existsSync(resolved)) return null;

    // Defeat symlink escape: realpath resolves the target, which we then
    // re-check against the same allow-list.
    let real: string;
    try { real = fs.realpathSync(resolved); } catch { return null; }
    const realCmp = norm(real) + (real.endsWith(path.sep) ? "" : path.sep);
    const realAllowed = scanFolders.some((folder) => {
        let f: string;
        try { f = fs.realpathSync(path.resolve(folder.path)); }
        catch { f = path.resolve(folder.path); }
        const fCmp = norm(f) + path.sep;
        return realCmp === fCmp || (norm(real) + path.sep).startsWith(fCmp);
    });
    if (!realAllowed) return null;

    return real;
}

/**
 * Directory variant — same checks as resolveAllowedFile but accepts the
 * scan folder itself or any subfolder. Used by routes that operate on
 * folders (`/scan`) rather than individual files.
 */
export function resolveAllowedFolder(
    rawPath: string,
    scanFolders: { path: string }[],
): string | null {
    if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.length > 4096) {
        return null;
    }
    if (/[\x00-\x1F]/.test(rawPath)) return null;

    let resolved: string;
    try { resolved = path.resolve(rawPath); } catch { return null; }
    const resolvedCmp = norm(resolved) + path.sep;
    const allowed = scanFolders.some((folder) => {
        const f = path.resolve(folder.path);
        const fCmp = norm(f) + path.sep;
        return resolvedCmp === fCmp || resolvedCmp.startsWith(fCmp);
    });
    if (!allowed) return null;

    if (!fs.existsSync(resolved)) return null;
    let real: string;
    try { real = fs.realpathSync(resolved); } catch { return null; }
    const realCmp = norm(real) + path.sep;
    const realAllowed = scanFolders.some((folder) => {
        let f: string;
        try { f = fs.realpathSync(path.resolve(folder.path)); }
        catch { f = path.resolve(folder.path); }
        const fCmp = norm(f) + path.sep;
        return realCmp === fCmp || realCmp.startsWith(fCmp);
    });
    if (!realAllowed) return null;
    return real;
}

/** Cheaper check: does this path lie inside any allowed scan folder?
 *  Skips realpath / existence checks — caller is just gating reads of
 *  in-memory metadata, not actually opening the file. Closes the
 *  sibling-prefix and case bugs but doesn't defeat symlink escape on
 *  its own. */
export function isPathInAllowedFolder(
    rawPath: string,
    scanFolders: { path: string }[],
): boolean {
    if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.length > 4096) {
        return false;
    }
    if (/[\x00-\x1F]/.test(rawPath)) return false;
    let resolved: string;
    try { resolved = path.resolve(rawPath); } catch { return false; }
    const resolvedCmp = norm(resolved) + (resolved.endsWith(path.sep) ? "" : path.sep);
    return scanFolders.some((folder) => {
        const fCmp = norm(path.resolve(folder.path)) + path.sep;
        return resolvedCmp === fCmp || resolvedCmp.startsWith(fCmp);
    });
}
