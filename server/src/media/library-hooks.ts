/**
 * Bridge between the video pillar (`library/video-*`) and the media library index.
 *
 * The video scanner / watcher call these hooks; `server.ts` installs the real
 * implementation once the media module exists. Before that (or in tests) the
 * hooks are no-ops, so the video code never depends on the media module.
 */

import fs from "node:fs";
import path from "node:path";
import { parseFilename } from "../library/video-scanner";
import type { LibraryIndex, LibraryFileInput } from "./library";
import type { MediaLogger } from "./types";

export interface ScannedForIndex {
    filepath: string;
    fileSize: number;
    mtime: number;
    parsedTitle: string;
    parsedYear: number | null;
    parsedSeason: number | null;
    parsedEpisode: number | null;
    showHint?: string | null;
}

export interface MediaLibraryHooks {
    /** Full snapshot of one scan root: upsert every file, prune the rest under that root. */
    onScanComplete(root: string, files: ScannedForIndex[]): Promise<void>;
    /** Incremental watcher flush. */
    onFilesChanged(added: string[], removed: string[]): Promise<void>;
}

const noop: MediaLibraryHooks = {
    async onScanComplete() { /* media module not installed */ },
    async onFilesChanged() { /* media module not installed */ },
};

let current: MediaLibraryHooks = noop;

export function setMediaLibraryHooks(hooks: MediaLibraryHooks | null): void {
    current = hooks ?? noop;
}

export function mediaLibraryHooks(): MediaLibraryHooks {
    return current;
}

/** Detect `Show Name/Season 01/file.mkv` layouts (mirrors video-scan-runner.detectShowHint). */
export function showHintFor(filePath: string, roots: string[]): string | null {
    const root = roots.find((r) => filePath.toLowerCase().startsWith(r.toLowerCase()));
    if (!root) return null;
    const rel = path.relative(root, filePath);
    if (!rel || rel.startsWith("..")) return null;
    const parts = rel.split(/[\\/]/);
    parts.pop();
    for (let i = parts.length - 1; i >= 0; i--) {
        const name = parts[i]!;
        if (/^(season[\s._-]*\d+|s\d{1,2}|specials?|extras?|featurettes?)$/i.test(name)) continue;
        return name.replace(/[._]/g, " ").replace(/\s+/g, " ").trim() || null;
    }
    return null;
}

export function toLibraryInput(f: ScannedForIndex): LibraryFileInput {
    return {
        path: f.filepath, size: f.fileSize, mtime: Math.round(f.mtime),
        title: f.parsedTitle, year: f.parsedYear, season: f.parsedSeason, episode: f.parsedEpisode, showHint: f.showHint ?? null,
    };
}

/** Real hooks over a `LibraryIndex`. */
export function createMediaLibraryHooks(index: LibraryIndex, opts: { getRoots: () => string[]; log?: MediaLogger }): MediaLibraryHooks {
    const upsertAll = async (inputs: LibraryFileInput[]) => {
        let matched = 0;
        for (const input of inputs) {
            try {
                const row = await index.upsertMatched(input);
                if (row.tmdbId !== null) matched++;
            } catch (err) {
                opts.log?.warn("[media/library] upsert failed", { path: input.path }, err);
            }
        }
        return matched;
    };
    return {
        async onScanComplete(root, files) {
            const t0 = Date.now();
            const matched = await upsertAll(files.map(toLibraryInput));
            const pruned = index.pruneUnder(root, files.map((f) => f.filepath));
            opts.log?.info("[media/library] scan indexed", { root, files: files.length, matched, pruned: pruned.length, etag: index.getEtag(), ms: Date.now() - t0 });
        },
        async onFilesChanged(added, removed) {
            if (removed.length > 0) index.removePaths(removed);
            const inputs: LibraryFileInput[] = [];
            const roots = opts.getRoots();
            for (const p of added) {
                try {
                    const st = fs.statSync(p);
                    const parsed = parseFilename(p);
                    inputs.push(toLibraryInput({
                        filepath: p, fileSize: st.size, mtime: st.mtimeMs, parsedTitle: parsed.title, parsedYear: parsed.year,
                        parsedSeason: parsed.season, parsedEpisode: parsed.episode, showHint: showHintFor(p, roots),
                    }));
                } catch { /* vanished between event and stat */ }
            }
            const matched = await upsertAll(inputs);
            if (added.length + removed.length > 0) {
                opts.log?.info("[media/library] watcher delta", { added: inputs.length, removed: removed.length, matched, etag: index.getEtag() });
            }
        },
    };
}
