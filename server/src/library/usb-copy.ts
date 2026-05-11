/**
 * USB copy: pure validation + path resolution helpers.
 *
 * The actual `fs.copyFile` work lives in the route handler (where SSE
 * progress is emitted). Splitting these helpers out lets us unit-test
 * the security-critical bits — path traversal, absolute-only
 * destinations, sanitised relative subdirs — without spinning up the
 * full Express stack.
 *
 * Threat model:
 *   The companion runs with the user's local filesystem privileges. A
 *   compromised browser tab (or a stolen device token) calling the USB
 *   copy endpoint must NOT be able to:
 *     1. Write outside the destination drive (path traversal via `..`).
 *     2. Coerce the music subdir into an absolute path that escapes the
 *        destination root.
 *     3. Use a filename containing path separators or `..` to land
 *        somewhere unexpected inside (or outside) the destination.
 *   All three are rejected here, before any FS call happens.
 */

import path from "node:path";

export interface CopyValidationOk {
    ok: true;
    /** Absolute, normalised destination root (the drive). */
    destination: string;
    /** Relative subdir under the destination (defaults to "Music"). */
    musicSubdir: string;
    /** Absolute resolved path to the directory tracks will land in. */
    targetDir: string;
}

export interface CopyValidationErr {
    ok: false;
    error: string;
}

export type CopyValidation = CopyValidationOk | CopyValidationErr;

const DEFAULT_SUBDIR = "Music";
const MAX_SUBDIR_LEN = 200;

/**
 * Validate the inputs to the USB copy endpoint. Rejects any request
 * whose `destination` isn't an absolute path or whose `musicSubdir`
 * tries to break out of the destination root via `..`, an absolute
 * leading slash, or a Windows drive prefix.
 *
 * Does NOT touch the filesystem — see `assertDestinationWritable`
 * for the side-effecting check.
 */
export function validateCopyRequest(input: {
    destination: unknown;
    musicSubdir?: unknown;
}): CopyValidation {
    if (typeof input.destination !== "string" || input.destination.trim() === "") {
        return { ok: false, error: "destination is required" };
    }
    const destRaw = input.destination.trim();
    if (!path.isAbsolute(destRaw)) {
        return { ok: false, error: "destination must be an absolute path" };
    }
    const destination = path.normalize(destRaw);

    let subdir = DEFAULT_SUBDIR;
    if (input.musicSubdir !== undefined && input.musicSubdir !== null) {
        if (typeof input.musicSubdir !== "string") {
            return { ok: false, error: "musicSubdir must be a string" };
        }
        const trimmed = input.musicSubdir.trim();
        if (trimmed === "") {
            // Empty → use default.
            subdir = DEFAULT_SUBDIR;
        } else {
            if (trimmed.length > MAX_SUBDIR_LEN) {
                return { ok: false, error: "musicSubdir too long" };
            }
            if (path.isAbsolute(trimmed)) {
                return { ok: false, error: "musicSubdir must be a relative path" };
            }
            // Block `..` segments (path-traversal) before AND after
            // normalisation. Normalisation can collapse `a/../b` into
            // `b`, hiding the intent — we reject either way.
            const segments = trimmed.split(/[\\/]+/);
            if (segments.some((s) => s === "..")) {
                return { ok: false, error: "musicSubdir must not contain `..`" };
            }
            subdir = path.normalize(trimmed);
            if (subdir.startsWith("..") || subdir.includes(`${path.sep}..${path.sep}`)) {
                return { ok: false, error: "musicSubdir must not escape destination" };
            }
        }
    }

    const targetDir = path.resolve(destination, subdir);
    // Extra defence-in-depth: after full resolution, the target dir
    // MUST still sit underneath the destination root. This catches any
    // platform-specific normalisation edge case the segment check
    // above might miss.
    const destResolved = path.resolve(destination);
    const sep = path.sep;
    if (
        targetDir !== destResolved &&
        !targetDir.startsWith(destResolved + sep)
    ) {
        return { ok: false, error: "resolved target escapes destination" };
    }

    return { ok: true, destination: destResolved, musicSubdir: subdir, targetDir };
}

/**
 * Compute the absolute target path for a single track being copied.
 * `sourceFilepath` comes from the tracks table; only its basename is
 * used so a malicious / weird stored filepath can't influence where
 * the file lands on the destination drive.
 */
export function resolveTrackTarget(targetDir: string, sourceFilepath: string): string {
    const basename = path.basename(sourceFilepath);
    if (!basename || basename === "." || basename === "..") {
        throw new Error(`invalid source filename: ${sourceFilepath}`);
    }
    return path.join(targetDir, basename);
}
