import type { VideoTech } from "@/components/video/poster-preview";

interface VideoFileLite {
    width?: number | null;
    height?: number | null;
    hdr?: string | null;
    videoCodec?: string | null;
    audioCodec?: string | null;
    audioTracks?: unknown;
    subtitleTracks?: unknown;
}

interface AudioTrack { codec?: string; channels?: number; language?: string; lang?: string; }
interface SubtitleTrack { language?: string; lang?: string; }

/**
 * Pick the "best" video file for badge display when a movie/episode has
 * multiple files: highest resolution wins, tie-break on bitrate.
 */
export function pickBestFile<T extends VideoFileLite & { bitrateKbps?: number | null }>(files: T[]): T | null {
    if (files.length === 0) return null;
    return [...files].sort((a, b) => {
        const ah = a.height ?? 0, bh = b.height ?? 0;
        if (ah !== bh) return bh - ah;
        return (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0);
    })[0];
}

export function fileToTech(f: VideoFileLite | null | undefined): VideoTech | null {
    if (!f) return null;
    const audioTracks = Array.isArray(f.audioTracks) ? (f.audioTracks as AudioTrack[]) : [];
    const subtitleTracks = Array.isArray(f.subtitleTracks) ? (f.subtitleTracks as SubtitleTrack[]) : [];
    const primaryAudio = audioTracks[0];
    const audioLangs = Array.from(new Set(audioTracks.map((a) => a.language ?? a.lang).filter((l): l is string => !!l)));
    const subtitleLangs = Array.from(new Set(subtitleTracks.map((s) => s.language ?? s.lang).filter((l): l is string => !!l)));
    return {
        width: f.width ?? null,
        height: f.height ?? null,
        hdr: f.hdr ?? null,
        videoCodec: f.videoCodec ?? null,
        audioCodec: f.audioCodec ?? primaryAudio?.codec ?? null,
        audioChannels: primaryAudio?.channels ?? null,
        audioLangs: audioLangs.length > 0 ? audioLangs : undefined,
        subtitleLangs: subtitleLangs.length > 0 ? subtitleLangs : undefined,
    };
}
