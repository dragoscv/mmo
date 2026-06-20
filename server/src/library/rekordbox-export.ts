/**
 * Rekordbox USB export — companion side.
 *
 * Bridges the local SQLite library to the native `rbexport` sidecar that
 * writes a true plug-and-play CDJ/XDJ USB (Contents/ audio + export.pdb +
 * exportExt.pdb + USBANLZ analysis files). The sidecar speaks a single
 * JSON manifest on stdin and emits newline-delimited JSON progress events
 * on stdout; this module builds the manifest from the user's tracks and
 * playlists, spawns the binary, and surfaces a typed event stream the
 * route handler proxies to the browser over SSE.
 *
 * SECURITY: the destination MUST be an absolute path (validated by the
 * caller). Track rows are always scoped to the authed user before they
 * reach the manifest.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

/** A cue point as the sidecar expects it. */
export interface ManifestCue {
    position_ms: number;
    is_hot: boolean;
    hot_index?: number;
    label?: string;
}

/** One track in the export manifest. */
export interface ManifestTrack {
    id: number;
    source_path: string;
    title?: string;
    artist?: string;
    album?: string;
    genre?: string;
    label?: string;
    key?: string;
    bpm?: number;
    duration_sec?: number;
    sample_rate?: number;
    bitrate?: number;
    cues?: ManifestCue[];
    /** Mono preview waveform samples (0..255), optional. */
    waveform_preview?: number[];
    /** Full-resolution detail waveform samples (0..255), optional. */
    waveform_detail?: number[];
}

export interface ManifestPlaylist {
    id: number;
    name: string;
    parent: number;
    is_folder: boolean;
    track_ids: number[];
}

export type TranscodePolicy = "none" | "incompatible" | "all";

export interface ExportOptions {
    write_pdb?: boolean;
    write_ext?: boolean;
    write_anlz?: boolean;
    auto_cue?: boolean;
    transcode?: TranscodePolicy;
    ffmpeg_path?: string;
}

export interface ExportManifest {
    destination: string;
    options: ExportOptions;
    tracks: ManifestTrack[];
    playlists: ManifestPlaylist[];
}

/** A progress event emitted by the sidecar (and forwarded to the browser). */
export interface ExportEvent {
    /** Event kind, e.g. "start" | "progress" | "stage" | "done" | "error". */
    kind: string;
    [key: string]: unknown;
}

/**
 * Locate the `rbexport` binary. In a packaged build it ships under
 * `resources/bin`; in dev it lives in the cargo target dir. Honour an
 * explicit override via `MMO_RBEXPORT` for testing.
 */
export function resolveRbexportBinary(): string | null {
    const exe = process.platform === "win32" ? "rbexport.exe" : "rbexport";
    const candidates = [
        process.env.MMO_RBEXPORT,
        path.join(process.resourcesPath ?? "", "bin", exe),
        path.join(__dirname, "..", "..", "native", "rbexport", "target", "release", exe),
        path.join(process.cwd(), "native", "rbexport", "target", "release", exe),
        path.join(process.cwd(), "server", "native", "rbexport", "target", "release", exe),
    ].filter((c): c is string => Boolean(c));
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    return null;
}

/**
 * Spawn the sidecar with the given manifest and stream progress events.
 *
 * @returns an async iterator of {@link ExportEvent}. The final event is
 * either `{kind:"done", ...}` or `{kind:"error", ...}`. Rejected events
 * (binary missing, spawn failure) are surfaced as a single `error` event.
 */
export async function* runExport(
    manifest: ExportManifest,
    opts: { binary?: string; signal?: AbortSignal } = {},
): AsyncGenerator<ExportEvent> {
    const binary = opts.binary ?? resolveRbexportBinary();
    if (!binary) {
        yield {
            kind: "error",
            error: "rbexport binary not found. Build it with `cargo build --release` in server/native/rbexport.",
        };
        return;
    }

    const child = spawn(binary, [], {
        stdio: ["pipe", "pipe", "pipe"],
        signal: opts.signal,
    });

    // Feed the manifest then close stdin so the sidecar starts working.
    child.stdin.write(JSON.stringify(manifest));
    child.stdin.end();

    const rl = readline.createInterface({ input: child.stdout });
    let stderr = "";
    child.stderr.on("data", (d) => {
        stderr += String(d);
    });

    // Bridge the event-emitter style stdout into an async queue we can
    // `yield` from. Lines that aren't valid JSON are surfaced as a
    // "log" event rather than dropped, which helps diagnose sidecar bugs.
    const queue: ExportEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let finished = false;

    const push = (ev: ExportEvent) => {
        queue.push(ev);
        resolveNext?.();
        resolveNext = null;
    };

    rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
            const parsed = JSON.parse(trimmed) as ExportEvent;
            push(parsed);
        } catch {
            push({ kind: "log", message: trimmed });
        }
    });

    child.on("error", (err) => {
        push({ kind: "error", error: err.message });
    });

    child.on("close", (code) => {
        if (code !== 0 && code !== null) {
            push({
                kind: "error",
                error: `rbexport exited with code ${code}`,
                stderr: stderr.slice(-2000),
            });
        }
        finished = true;
        resolveNext?.();
        resolveNext = null;
    });

    while (true) {
        if (queue.length > 0) {
            yield queue.shift()!;
            continue;
        }
        if (finished) return;
        await new Promise<void>((resolve) => {
            resolveNext = resolve;
        });
    }
}
