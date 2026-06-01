import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { requireSessionWithRate } from "@/lib/api-guard";
import { validatePublicHttpUrl } from "@/lib/url-guard";
import { resolveYtDlpBinary } from "@/lib/yt-dlp-bin";

// Spawns yt-dlp (child_process) and may download a standalone binary into
// /tmp on first cold start, so this must run on the Node.js runtime, never
// Edge. Allow extra time for the one-off cold-start binary download.
export const runtime = "nodejs";
export const maxDuration = 120;

// ─── Types ───────────────────────────────────────────────────────────────

export interface MediaFormat {
    formatId: string;
    ext: string;
    resolution: string;
    filesize: number | null;
    filesizeApprox: number | null;
    acodec: string;
    vcodec: string;
    abr: number | null;
    vbr: number | null;
    fps: number | null;
    tbr: number | null;
    quality: string;
    type: "audio" | "video" | "audio+video";
}

export interface MediaInfo {
    id: string;
    title: string;
    description: string;
    duration: number;
    thumbnail: string;
    uploader: string;
    uploaderUrl: string;
    webpage_url: string;
    extractor: string;
    formats: MediaFormat[];
}

export interface PlaylistEntry {
    id: string;
    title: string;
    duration: number;
    thumbnail: string;
    uploader: string;
    url: string;
}

export interface PlaylistInfo {
    _type: "playlist";
    id: string;
    title: string;
    description: string;
    uploader: string;
    uploaderUrl: string;
    webpage_url: string;
    extractor: string;
    thumbnail: string;
    entryCount: number;
    entries: PlaylistEntry[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function classifyFormat(f: Record<string, unknown>): "audio" | "video" | "audio+video" {
    const hasVideo = f.vcodec && f.vcodec !== "none";
    const hasAudio = f.acodec && f.acodec !== "none";
    if (hasVideo && hasAudio) return "audio+video";
    if (hasVideo) return "video";
    return "audio";
}

async function runYtDlp(args: string[], timeoutMs = 30_000): Promise<string> {
    let bin: string;
    try {
        bin = await resolveYtDlpBinary();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`yt-dlp is not available: ${msg}`);
    }
    return new Promise((resolve, reject) => {
        const proc = spawn(bin, args, { windowsHide: true });
        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

        proc.on("close", (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(0, 500)}`));
        });

        proc.on("error", (err) => {
            reject(new Error(`Failed to run yt-dlp: ${err.message}. Is yt-dlp installed?`));
        });

        const timer = setTimeout(() => {
            proc.kill("SIGTERM");
            reject(new Error(`yt-dlp timed out after ${timeoutMs / 1000} seconds`));
        }, timeoutMs);

        proc.on("close", () => clearTimeout(timer));
    });
}

function parseFormats(data: Record<string, unknown>): MediaFormat[] {
    return ((data.formats || []) as Record<string, unknown>[])
        .filter((f) => {
            const hasAudio = f.acodec && f.acodec !== "none";
            const hasVideo = f.vcodec && f.vcodec !== "none";
            return hasAudio || hasVideo;
        })
        .map((f) => ({
            formatId: String(f.format_id || ""),
            ext: String(f.ext || ""),
            resolution: String(f.resolution || f.format_note || "unknown"),
            filesize: typeof f.filesize === "number" ? f.filesize : null,
            filesizeApprox: typeof f.filesize_approx === "number" ? f.filesize_approx : null,
            acodec: String(f.acodec || "none"),
            vcodec: String(f.vcodec || "none"),
            abr: typeof f.abr === "number" ? f.abr : null,
            vbr: typeof f.vbr === "number" ? f.vbr : null,
            fps: typeof f.fps === "number" ? f.fps : null,
            tbr: typeof f.tbr === "number" ? f.tbr : null,
            quality: String(f.format_note || f.quality || ""),
            type: classifyFormat(f),
        }));
}

function parseSingleTrack(data: Record<string, unknown>): MediaInfo {
    return {
        id: String(data.id || ""),
        title: String(data.title || data.fulltitle || "Unknown"),
        description: String(data.description || "").slice(0, 500),
        duration: Number(data.duration || 0),
        thumbnail: String(data.thumbnail || ""),
        uploader: String(data.uploader || data.channel || ""),
        uploaderUrl: String(data.uploader_url || data.channel_url || ""),
        webpage_url: String(data.webpage_url || ""),
        extractor: String(data.extractor_key || data.extractor || ""),
        formats: parseFormats(data),
    };
}

function parsePlaylistData(data: Record<string, unknown>, url: string): PlaylistInfo | null {
    if (data._type !== "playlist" || !Array.isArray(data.entries) || data.entries.length === 0) {
        return null;
    }

    const entries: PlaylistEntry[] = (data.entries as Record<string, unknown>[])
        .filter((e) => e && e.id)
        .map((e) => ({
            id: String(e.id || ""),
            title: String(e.title || "Unknown"),
            duration: Number(e.duration || 0),
            thumbnail: String(
                (e.thumbnails as Record<string, unknown>[] | undefined)?.[0]?.url || e.thumbnail || ""
            ),
            uploader: String(e.uploader || e.channel || data.uploader || ""),
            url: String(e.url || e.webpage_url || ""),
        }));

    if (entries.length === 0) return null;

    return {
        _type: "playlist",
        id: String(data.id || ""),
        title: String(data.title || "Unknown Playlist"),
        description: String(data.description || "").slice(0, 500),
        uploader: String(data.uploader || data.channel || ""),
        uploaderUrl: String(data.uploader_url || data.channel_url || ""),
        webpage_url: String(data.webpage_url || url),
        extractor: String(data.extractor_key || data.extractor || ""),
        thumbnail: String(
            (data.thumbnails as Record<string, unknown>[] | undefined)?.[0]?.url || ""
        ),
        entryCount: entries.length,
        entries,
    };
}

async function tryPlaylist(url: string): Promise<PlaylistInfo | MediaInfo | null> {
    const raw = await runYtDlp([
        "--flat-playlist", "-J", "--no-download", "--no-warnings", "--", url,
    ], 60_000);
    const data = JSON.parse(raw);

    const playlist = parsePlaylistData(data, url);
    if (playlist) return playlist;

    // Maybe it returned a single track via -J
    if (data.formats) return parseSingleTrack(data);

    // Single-entry playlist — recheck the entry URL through the same
    // public-URL guard before re-spawning yt-dlp, so a playlist whose
    // entries point at e.g. file:/// or 169.254.169.254 still gets
    // rejected on the recursive call.
    if (data._type === "playlist" && data.entries?.length === 1) {
        const entry = data.entries[0];
        const entryUrl = validatePublicHttpUrl(entry.url || entry.webpage_url);
        if (!entryUrl) return null;
        const singleRaw = await runYtDlp([
            "-j", "--no-download", "--no-warnings", "--no-playlist", "--",
            entryUrl,
        ]);
        return parseSingleTrack(JSON.parse(singleRaw));
    }

    return null;
}

// ─── Route Handler ───────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
    const guard = await requireSessionWithRate(request, { bucket: "download-info", windowMs: 60_000, max: 30 });
    if (guard.response) return guard.response;
    try {
        const body = await request.json();
        const rawUrl = body?.url;

        // SSRF + CLI-flag-injection guard. yt-dlp will happily fetch from
        // file://, ftp://, http://localhost, http://169.254.169.254 (cloud
        // metadata), and any RFC1918 / link-local target — turning this
        // route into an SSRF gadget. It also accepts options anywhere on
        // the command line, so a URL beginning with `-` (e.g.
        // `--exec=...`, `--config-location=/etc/passwd`) becomes RCE.
        // `validatePublicHttpUrl` rejects all of those; we additionally
        // pass `--` before the URL on every spawn so even a missed leading
        // `-` cannot be reinterpreted as a flag.
        const url = validatePublicHttpUrl(rawUrl);
        if (!url) {
            return NextResponse.json(
                { error: "URL must be a public http(s) link to a supported media site" },
                { status: 400 }
            );
        }

        // Detect if URL contains playlist indicators
        const hasPlaylistHint = /[?&]list=|\/sets\/|\/playlist\/|\/album\//i.test(url);

        if (hasPlaylistHint) {
            // URL looks like it contains a playlist — try playlist first
            try {
                const playlistResult = await tryPlaylist(url);
                if (playlistResult) return NextResponse.json(playlistResult);
            } catch { /* fall through to single track */ }

            // Playlist extraction failed, try as single track
            try {
                const raw = await runYtDlp([
                    "-j", "--no-download", "--no-warnings", "--no-playlist", "--", url,
                ]);
                return NextResponse.json(parseSingleTrack(JSON.parse(raw)));
            } catch (err) {
                const msg = err instanceof Error ? err.message : "Failed to extract media info";
                return NextResponse.json({ error: msg }, { status: 500 });
            }
        }

        // No playlist hint — try single track first
        let singleError: string | null = null;
        try {
            const raw = await runYtDlp([
                "-j", "--no-download", "--no-warnings", "--no-playlist", "--", url,
            ]);
            const data = JSON.parse(raw);
            return NextResponse.json(parseSingleTrack(data));
        } catch (err) {
            singleError = err instanceof Error ? err.message : "Unknown error";
        }

        // Step 2: If single track failed, try as playlist
        try {
            const playlistResult = await tryPlaylist(url);
            if (playlistResult) return NextResponse.json(playlistResult);
        } catch {
            // Both approaches failed, return original error
        }

        return NextResponse.json({ error: singleError || "Failed to extract media info" }, { status: 500 });
    } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
