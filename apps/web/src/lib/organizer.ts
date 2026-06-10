import fs from "node:fs";
import path from "node:path";

export interface MoveResult {
    success: boolean;
    newPath: string;
    error?: string;
}

/** A single completed move — feed back into `undoMove()` to revert it. */
export interface MoveRecord {
    from: string;
    to: string;
}

/** Result envelope from `batchMoveTracks` / `batchOrganize`. */
export interface BatchMoveResult {
    moved: MoveRecord[];
    failures: Array<{ from: string; error: string }>;
}

export function moveTrackToGenreFolder(
    currentPath: string,
    musicRoot: string,
    genreFolder: string
): MoveResult {
    try {
        if (!fs.existsSync(currentPath)) {
            return { success: false, newPath: currentPath, error: "File not found" };
        }

        const targetDir = path.join(musicRoot, genreFolder);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        const filename = path.basename(currentPath);
        let newPath = path.join(targetDir, filename);

        // Handle name conflicts
        if (fs.existsSync(newPath) && newPath !== currentPath) {
            const ext = path.extname(filename);
            const name = path.basename(filename, ext);
            let counter = 1;
            while (fs.existsSync(newPath)) {
                newPath = path.join(targetDir, `${name} (${counter})${ext}`);
                counter++;
            }
        }

        if (newPath === currentPath) {
            return { success: true, newPath };
        }

        fs.renameSync(currentPath, newPath);
        return { success: true, newPath };
    } catch (err) {
        return {
            success: false,
            newPath: currentPath,
            error: err instanceof Error ? err.message : "Unknown error",
        };
    }
}

export function renameTrack(
    currentPath: string,
    artist: string,
    title: string,
    remix?: string
): MoveResult {
    try {
        if (!fs.existsSync(currentPath)) {
            return { success: false, newPath: currentPath, error: "File not found" };
        }

        const ext = path.extname(currentPath);
        const dir = path.dirname(currentPath);

        let newName = `${sanitizeFilename(artist)} - ${sanitizeFilename(title)}`;
        if (remix) {
            newName += ` (${sanitizeFilename(remix)})`;
        }
        newName += ext;

        const newPath = path.join(dir, newName);

        if (newPath === currentPath) {
            return { success: true, newPath };
        }

        if (fs.existsSync(newPath)) {
            return {
                success: false,
                newPath: currentPath,
                error: "File with that name already exists",
            };
        }

        fs.renameSync(currentPath, newPath);
        return { success: true, newPath };
    } catch (err) {
        return {
            success: false,
            newPath: currentPath,
            error: err instanceof Error ? err.message : "Unknown error",
        };
    }
}

export function sanitizeFilename(name: string): string {
    return name.replace(/[<>:"/\\|?*]/g, "").trim();
}

/**
 * Move a list of tracks into per-track genre folders under the same
 * `musicRoot`, returning every successful move as a `MoveRecord` so the
 * caller can later feed the array into `undoMoves()` to revert. Failures
 * are collected — one bad file never aborts the rest of the batch.
 */
export function batchMoveTracks(
    items: Array<{ currentPath: string; genreFolder: string }>,
    musicRoot: string,
): BatchMoveResult {
    const moved: MoveRecord[] = [];
    const failures: BatchMoveResult["failures"] = [];
    for (const it of items) {
        const r = moveTrackToGenreFolder(it.currentPath, musicRoot, it.genreFolder);
        if (r.success && r.newPath !== it.currentPath) {
            moved.push({ from: it.currentPath, to: r.newPath });
        } else if (!r.success) {
            failures.push({ from: it.currentPath, error: r.error ?? "Unknown" });
        }
    }
    return { moved, failures };
}

/**
 * Reverse a single move: rename the file at `record.to` back to
 * `record.from`. Refuses to overwrite if a file already sits at the
 * original path (e.g. the user re-created a track there meanwhile).
 */
export function undoMove(record: MoveRecord): MoveResult {
    try {
        if (!fs.existsSync(record.to)) {
            return { success: false, newPath: record.to, error: "Moved file no longer exists" };
        }
        if (fs.existsSync(record.from) && record.from !== record.to) {
            return { success: false, newPath: record.to, error: "Original location is occupied" };
        }
        const dir = path.dirname(record.from);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.renameSync(record.to, record.from);
        return { success: true, newPath: record.from };
    } catch (err) {
        return {
            success: false,
            newPath: record.to,
            error: err instanceof Error ? err.message : "Unknown error",
        };
    }
}

/**
 * Reverse a batch of moves in REVERSE order (LIFO). Returns the per-move
 * outcomes so the caller can show partial results in the UI.
 */
export function undoMoves(records: MoveRecord[]): Array<{ record: MoveRecord; result: MoveResult }> {
    const out: Array<{ record: MoveRecord; result: MoveResult }> = [];
    for (let i = records.length - 1; i >= 0; i--) {
        out.push({ record: records[i], result: undoMove(records[i]) });
    }
    return out;
}
