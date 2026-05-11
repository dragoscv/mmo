"use client";

import { useState, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useDAW } from "./daw-context";
import { cn } from "@/lib/utils";
import {
    X, Download, FileAudio, Check, Loader2, Music,
    ChevronDown, ChevronRight, Tag, Save, Sparkles,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────

type Format = "wav" | "mp3" | "flac" | "ogg";
type PresetKey = "cd" | "studio" | "streaming" | "podcast" | "custom";

interface ExportConfig {
    format: Format;
    sampleRate: number;
    bitDepth: number;
    bitRate: number;
    channels: 1 | 2;
    normalize: boolean;
    dither: boolean;
    limitPeak: boolean;
    tailSec: number;
}

interface ExportMetadata {
    title: string;
    artist: string;
    album: string;
    genre: string;
    year: string;
    comment: string;
    trackNumber: string;
}

// ─── Constants ────────────────────────────────────────────────────────────

const STORAGE_KEY = "daw-export-config";

const FORMAT_INFO: Record<Format, {
    label: string;
    ext: string;
    desc: string;
    lossy: boolean;
    defaultBitRate: number;
    bitRates: number[];
}> = {
    wav: {
        label: "WAV", ext: ".wav",
        desc: "Uncompressed PCM — best quality, largest files",
        lossy: false, defaultBitRate: 0, bitRates: [],
    },
    flac: {
        label: "FLAC", ext: ".flac",
        desc: "Lossless compression — perfect quality, ~60% size of WAV",
        lossy: false, defaultBitRate: 0, bitRates: [],
    },
    mp3: {
        label: "MP3", ext: ".mp3",
        desc: "Lossy — universal compatibility, good quality at 320kbps",
        lossy: true, defaultBitRate: 320, bitRates: [128, 160, 192, 224, 256, 320],
    },
    ogg: {
        label: "OGG", ext: ".ogg",
        desc: "Lossy — open format, better quality per bitrate than MP3",
        lossy: true, defaultBitRate: 256, bitRates: [96, 128, 160, 192, 224, 256, 320],
    },
};

const PRESETS: Record<PresetKey, { label: string; desc: string; config: ExportConfig }> = {
    cd: {
        label: "CD Quality",
        desc: "44.1 kHz · 16-bit · Stereo WAV",
        config: { format: "wav", sampleRate: 44100, bitDepth: 16, bitRate: 0, channels: 2, normalize: true, dither: true, limitPeak: true, tailSec: 0.5 },
    },
    studio: {
        label: "Studio Master",
        desc: "96 kHz · 32-bit · Stereo WAV",
        config: { format: "wav", sampleRate: 96000, bitDepth: 32, bitRate: 0, channels: 2, normalize: false, dither: false, limitPeak: true, tailSec: 1 },
    },
    streaming: {
        label: "Streaming",
        desc: "MP3 320 kbps · 44.1 kHz · Stereo",
        config: { format: "mp3", sampleRate: 44100, bitDepth: 16, bitRate: 320, channels: 2, normalize: true, dither: false, limitPeak: true, tailSec: 0 },
    },
    podcast: {
        label: "Podcast / Voice",
        desc: "MP3 192 kbps · 44.1 kHz · Mono",
        config: { format: "mp3", sampleRate: 44100, bitDepth: 16, bitRate: 192, channels: 1, normalize: true, dither: false, limitPeak: true, tailSec: 0 },
    },
    custom: {
        label: "Custom",
        desc: "Configure your own settings",
        config: { format: "wav", sampleRate: 48000, bitDepth: 24, bitRate: 320, channels: 2, normalize: true, dither: true, limitPeak: true, tailSec: 1 },
    },
};

const SAMPLE_RATES = [44100, 48000, 88200, 96000];
const BIT_DEPTHS = [16, 24, 32];

function estimateFileSize(durationSec: number, format: Format, sampleRate: number, bitDepth: number, bitRate: number, channels: number): string {
    let bytes: number;
    if (FORMAT_INFO[format].lossy) {
        bytes = (bitRate * 1000 * durationSec) / 8;
    } else if (format === "flac") {
        bytes = sampleRate * (bitDepth / 8) * channels * durationSec * 0.6;
    } else {
        bytes = sampleRate * (bitDepth / 8) * channels * durationSec;
    }
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatDuration(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

function loadSavedConfig(): ExportConfig | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw) as ExportConfig;
    } catch {
        return null;
    }
}

function saveConfig(config: ExportConfig) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch { /* ignore */ }
}

function detectPreset(config: ExportConfig): PresetKey {
    for (const [key, preset] of Object.entries(PRESETS) as [PresetKey, typeof PRESETS[PresetKey]][]) {
        if (key === "custom") continue;
        const p = preset.config;
        if (
            p.format === config.format &&
            p.sampleRate === config.sampleRate &&
            p.bitDepth === config.bitDepth &&
            p.bitRate === config.bitRate &&
            p.channels === config.channels
        ) return key;
    }
    return "custom";
}

// ─── Component ────────────────────────────────────────────────────────────

export function DAWExportModal() {
    const daw = useDAW();
    const t = useTranslations("dawExport");
    const project = daw.project;

    // Load saved config or default to CD Quality
    const [initialized, setInitialized] = useState(false);
    const [preset, setPreset] = useState<PresetKey>("cd");
    const [format, setFormat] = useState<Format>("wav");
    const [sampleRate, setSampleRate] = useState(48000);
    const [bitDepth, setBitDepth] = useState(24);
    const [bitRate, setBitRate] = useState(320);
    const [channels, setChannels] = useState<1 | 2>(2);
    const [normalize, setNormalize] = useState(true);
    const [dither, setDither] = useState(true);
    const [tailSec, setTailSec] = useState(1);
    const [limitPeak, setLimitPeak] = useState(true);
    const [rememberConfig, setRememberConfig] = useState(false);

    // Metadata
    const [showMeta, setShowMeta] = useState(false);
    const [meta, setMeta] = useState<ExportMetadata>({
        title: project.name,
        artist: "",
        album: "",
        genre: "",
        year: new Date().getFullYear().toString(),
        comment: "",
        trackNumber: "",
    });

    // Export state
    const [exporting, setExporting] = useState(false);
    const [progress, setProgress] = useState(0);
    const [done, setDone] = useState(false);
    const [exportedBlob, setExportedBlob] = useState<Blob | null>(null);
    const [exportedSize, setExportedSize] = useState("");
    const [error, setError] = useState<string | null>(null);

    // Load saved config on mount
    useEffect(() => {
        const saved = loadSavedConfig();
        if (saved) {
            applyConfig(saved);
            // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only localStorage hydration after SSR
            setRememberConfig(true);
            setPreset(detectPreset(saved));
        }
        setInitialized(true);
         
    }, []);

    const currentConfig = useCallback((): ExportConfig => ({
        format, sampleRate, bitDepth, bitRate, channels, normalize, dither, limitPeak, tailSec,
    }), [format, sampleRate, bitDepth, bitRate, channels, normalize, dither, limitPeak, tailSec]);

    // Save when config changes & rememberConfig is on
    useEffect(() => {
        if (!initialized) return;
        if (rememberConfig) {
            saveConfig(currentConfig());
        } else {
            try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
        }
    }, [initialized, rememberConfig, currentConfig]);

    function applyConfig(c: ExportConfig) {
        setFormat(c.format);
        setSampleRate(c.sampleRate);
        setBitDepth(c.bitDepth);
        setBitRate(c.bitRate);
        setChannels(c.channels);
        setNormalize(c.normalize);
        setDither(c.dither);
        setLimitPeak(c.limitPeak);
        setTailSec(c.tailSec);
    }

    function applyPreset(key: PresetKey) {
        setPreset(key);
        if (key !== "custom") {
            applyConfig(PRESETS[key].config);
        }
    }

    // When user changes any setting, switch to "custom" if it no longer matches
    function markCustom() {
        // Defer to next tick so state is updated
        setTimeout(() => {
            setPreset(prev => {
                if (prev === "custom") return prev;
                return "custom";
            });
        }, 0);
    }

    // Duration calc
    const maxBeat = project.tracks.reduce((max, t) =>
        Math.max(max, ...t.clips.map(c => c.position + c.length), max), project.duration || 32);
    const durationSec = (maxBeat / project.tempo) * 60 + tailSec;
    const effectiveBitRate = FORMAT_INFO[format].lossy ? bitRate : 0;

    const handleExport = useCallback(async () => {
        setExporting(true);
        setProgress(0);
        setDone(false);
        setError(null);
        setExportedBlob(null);

        try {
            const result = await daw.exportProject(format, {
                bitRate: effectiveBitRate,
                bitDepth: bitDepth as 16 | 24 | 32,
                sampleRate,
                channels,
                normalize,
                limitPeak,
                tailSec,
                onProgress: (pct) => setProgress(pct),
            });
            if (result) {
                setExportedBlob(result.blob);
                setExportedSize(
                    result.blob.size >= 1048576
                        ? `${(result.blob.size / 1048576).toFixed(1)} MB`
                        : `${(result.blob.size / 1024).toFixed(0)} KB`
                );
                setDone(true);
                setProgress(100);
            } else {
                setError("Export failed — engine not initialized");
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "Export failed");
        } finally {
            setExporting(false);
        }
    }, [daw, format, effectiveBitRate]);

    const handleDownload = useCallback(() => {
        if (!exportedBlob) return;
        const url = URL.createObjectURL(exportedBlob);
        const a = document.createElement("a");
        a.href = url;
        const filename = (meta.artist && meta.title)
            ? `${meta.artist} - ${meta.title}${FORMAT_INFO[format].ext}`
            : `${meta.title || project.name}${FORMAT_INFO[format].ext}`;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }, [exportedBlob, meta, project.name, format]);

    const handleClose = () => {
        if (exporting) return;
        setDone(false);
        setExportedBlob(null);
        setProgress(0);
        setError(null);
        daw.setExportModal(false);
    };

    const updateMeta = (key: keyof ExportMetadata, value: string) => {
        setMeta(prev => ({ ...prev, [key]: value }));
    };

    if (!daw.showExportModal) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-3 sm:p-4" onClick={handleClose}>
            <div
                className="w-full max-w-[560px] max-h-[calc(100dvh-1.5rem)] sm:max-h-[90vh] bg-[var(--daw-bg)] border border-[var(--daw-border)] rounded-xl shadow-2xl flex flex-col overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                    <div className="flex items-center gap-2">
                        <Download className="h-4 w-4 text-purple-400" />
                        <h2 className="text-sm font-medium text-white/80">{t("title")}</h2>
                    </div>
                    <button
                        onClick={handleClose}
                        disabled={exporting}
                        className="w-6 h-6 rounded flex items-center justify-center text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors disabled:opacity-30"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {/* Project summary */}
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-black/20 border border-white/[0.06]">
                        <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center flex-shrink-0">
                            <Music className="h-5 w-5 text-purple-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-xs text-white/70 truncate">{project.name}</p>
                            <p className="text-[10px] text-white/30">
                                {project.tracks.length} tracks · {project.tempo} BPM · ~{formatDuration(durationSec)}
                            </p>
                        </div>
                    </div>

                    {/* ─── Quality Presets ─────────────────────────────────── */}
                    <Section label={t("sectionPreset")}>
                        <div className="flex gap-1.5 flex-wrap">
                            {(Object.entries(PRESETS) as [PresetKey, typeof PRESETS[PresetKey]][]).map(([key, p]) => (
                                <button
                                    key={key}
                                    onClick={() => applyPreset(key)}
                                    disabled={exporting}
                                    className={cn(
                                        "h-[52px] px-3 rounded-lg border text-left transition-all flex flex-col justify-center gap-0.5",
                                        key === "custom" ? "min-w-[80px]" : "min-w-[110px]",
                                        preset === key
                                            ? "bg-purple-500/15 border-purple-500/40"
                                            : "bg-black/20 border-white/[0.06] hover:border-white/10"
                                    )}
                                >
                                    <span className={cn(
                                        "text-[10px] font-medium flex items-center gap-1",
                                        preset === key ? "text-purple-400" : "text-white/50"
                                    )}>
                                        {key === "custom" && <Sparkles className="h-3 w-3" />}
                                        {p.label}
                                    </span>
                                    <span className="text-[8px] text-white/20 leading-tight">{p.desc}</span>
                                </button>
                            ))}
                        </div>
                    </Section>

                    {/* ─── Format ─────────────────────────────────────────── */}
                    <Section label={t("sectionFormat")}>
                        <div className="grid grid-cols-4 gap-1.5">
                            {(Object.keys(FORMAT_INFO) as Format[]).map(f => {
                                const info = FORMAT_INFO[f];
                                return (
                                    <button
                                        key={f}
                                        onClick={() => {
                                            setFormat(f);
                                            if (info.lossy) setBitRate(info.defaultBitRate);
                                            markCustom();
                                        }}
                                        disabled={exporting}
                                        className={cn(
                                            "h-16 rounded-lg border text-center transition-all flex flex-col items-center justify-center gap-1",
                                            format === f
                                                ? "bg-purple-500/15 border-purple-500/40 text-purple-400"
                                                : "bg-black/20 border-white/[0.06] text-white/40 hover:text-white/60 hover:border-white/10"
                                        )}
                                    >
                                        <FileAudio className="h-4 w-4" />
                                        <span className="text-[10px] font-medium">{info.label}</span>
                                        <span className="text-[8px] opacity-50">{info.lossy ? t("lossy") : t("lossless")}</span>
                                    </button>
                                );
                            })}
                        </div>
                        <p className="text-[9px] text-white/15 mt-1.5">{FORMAT_INFO[format].desc}</p>
                    </Section>

                    {/* ─── Quality ────────────────────────────────────────── */}
                    <Section label={t("sectionQuality")}>
                        <div className="grid grid-cols-2 gap-3">
                            {/* Sample Rate */}
                            <div>
                                <label className="text-[9px] text-white/25 block mb-1">{t("sampleRate")}</label>
                                <DawSelect
                                    value={sampleRate}
                                    onChange={v => { setSampleRate(Number(v)); markCustom(); }}
                                    disabled={exporting}
                                    options={SAMPLE_RATES.map(sr => ({ value: sr, label: `${(sr / 1000).toFixed(1)} kHz` }))}
                                />
                            </div>

                            {/* Bit Depth or Bitrate */}
                            {!FORMAT_INFO[format].lossy ? (
                                <div>
                                    <label className="text-[9px] text-white/25 block mb-1">{t("bitDepth")}</label>
                                    <DawSelect
                                        value={bitDepth}
                                        onChange={v => { setBitDepth(Number(v)); markCustom(); }}
                                        disabled={exporting}
                                        options={BIT_DEPTHS.map(bd => ({ value: bd, label: `${bd}-bit` }))}
                                    />
                                </div>
                            ) : (
                                <div>
                                    <label className="text-[9px] text-white/25 block mb-1">{t("bitrate")}</label>
                                    <DawSelect
                                        value={bitRate}
                                        onChange={v => { setBitRate(Number(v)); markCustom(); }}
                                        disabled={exporting}
                                        options={FORMAT_INFO[format].bitRates.map(br => ({
                                            value: br,
                                            label: `${br} kbps${br >= 256 ? " (High)" : br >= 192 ? " (Good)" : ""}`,
                                        }))}
                                    />
                                </div>
                            )}

                            {/* Channels */}
                            <div>
                                <label className="text-[9px] text-white/25 block mb-1">{t("channels")}</label>
                                <div className="flex gap-1">
                                    {([2, 1] as const).map(ch => (
                                        <button
                                            key={ch}
                                            onClick={() => { setChannels(ch); markCustom(); }}
                                            disabled={exporting}
                                            className={cn(
                                                "flex-1 h-7 rounded border text-[10px] transition-all",
                                                channels === ch
                                                    ? "bg-purple-500/15 border-purple-500/40 text-purple-400"
                                                    : "bg-black/20 border-white/[0.06] text-white/40 hover:text-white/60"
                                            )}
                                        >
                                            {ch === 2 ? t("stereo") : t("mono")}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Bit rate slider for lossy */}
                            {FORMAT_INFO[format].lossy && (
                                <div>
                                    <label className="text-[9px] text-white/25 block mb-1">{t("qualitySlider")}</label>
                                    <input
                                        type="range"
                                        min={FORMAT_INFO[format].bitRates[0]}
                                        max={FORMAT_INFO[format].bitRates[FORMAT_INFO[format].bitRates.length - 1]}
                                        step={32}
                                        value={bitRate}
                                        onChange={e => { setBitRate(Number(e.target.value)); markCustom(); }}
                                        disabled={exporting}
                                        className="w-full h-1 accent-purple-500"
                                    />
                                    <div className="flex justify-between mt-0.5">
                                        <span className="text-[8px] text-white/15">{t("smaller")}</span>
                                        <span className="text-[8px] text-white/15">{t("better")}</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    </Section>

                    {/* ─── Processing ─────────────────────────────────────── */}
                    <Section label="Processing">
                        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                            <DawCheckbox
                                label="Normalize to 0 dBFS"
                                desc="Maximize volume without clipping"
                                checked={normalize}
                                onChange={v => { setNormalize(v); markCustom(); }}
                                disabled={exporting}
                            />
                            <DawCheckbox
                                label="Dithering"
                                desc="Reduce quantization noise on bit depth reduction"
                                checked={dither}
                                onChange={v => { setDither(v); markCustom(); }}
                                disabled={exporting}
                            />
                            <DawCheckbox
                                label="Brick-wall limiter"
                                desc="Prevent peaks from exceeding 0 dBFS"
                                checked={limitPeak}
                                onChange={v => { setLimitPeak(v); markCustom(); }}
                                disabled={exporting}
                            />
                            <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-white/35">Tail</span>
                                <input
                                    type="number"
                                    min={0}
                                    max={10}
                                    step={0.5}
                                    value={tailSec}
                                    onChange={e => { setTailSec(Number(e.target.value)); markCustom(); }}
                                    disabled={exporting}
                                    className="w-14 h-6 px-1.5 bg-black/30 border border-white/10 rounded text-[10px] text-white/60 focus:outline-none focus:border-purple-500/50 text-center"
                                />
                                <span className="text-[10px] text-white/25">sec reverb tail</span>
                            </div>
                        </div>
                    </Section>

                    {/* ─── Metadata (Collapsible) ────────────────────────── */}
                    <div>
                        <button
                            onClick={() => setShowMeta(!showMeta)}
                            className="flex items-center gap-1.5 text-[10px] text-white/30 uppercase tracking-wider hover:text-white/50 transition-colors mb-2"
                        >
                            {showMeta ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                            <Tag className="h-3 w-3" />
                            {t("sectionMetadata")}
                        </button>
                        {showMeta && (
                            <div className="grid grid-cols-2 gap-x-3 gap-y-2 p-3 rounded-lg bg-black/15 border border-white/[0.04]">
                                <MetaField label={t("metaTitle")} value={meta.title} onChange={v => updateMeta("title", v)} disabled={exporting} />
                                <MetaField label={t("metaArtist")} value={meta.artist} onChange={v => updateMeta("artist", v)} disabled={exporting} placeholder={t("metaArtistPh")} />
                                <MetaField label={t("metaAlbum")} value={meta.album} onChange={v => updateMeta("album", v)} disabled={exporting} placeholder={t("metaAlbumPh")} />
                                <MetaField label={t("metaGenre")} value={meta.genre} onChange={v => updateMeta("genre", v)} disabled={exporting} placeholder={t("metaGenrePh")} />
                                <MetaField label={t("metaYear")} value={meta.year} onChange={v => updateMeta("year", v)} disabled={exporting} placeholder="2026" />
                                <MetaField label={t("metaTrack")} value={meta.trackNumber} onChange={v => updateMeta("trackNumber", v)} disabled={exporting} placeholder="1" />
                                <div className="col-span-2">
                                    <MetaField label={t("metaComment")} value={meta.comment} onChange={v => updateMeta("comment", v)} disabled={exporting} placeholder={t("metaCommentPh")} />
                                </div>
                            </div>
                        )}
                    </div>

                    {/* ─── File Size Estimate ────────────────────────────── */}
                    <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-black/15 border border-white/[0.04]">
                        <div className="flex items-center gap-3">
                            <span className="text-[10px] text-white/25">{t("estimatedSize")}</span>
                            <span className="text-[10px] text-white/50 font-medium tabular-nums">
                                {estimateFileSize(durationSec, format, sampleRate, bitDepth, effectiveBitRate || (sampleRate * bitDepth * channels / 1000), channels)}
                            </span>
                        </div>
                        <div className="flex items-center gap-3 text-[9px] text-white/20">
                            <span>{channels === 2 ? "Stereo" : "Mono"}</span>
                            <span>{(sampleRate / 1000).toFixed(1)} kHz</span>
                            {!FORMAT_INFO[format].lossy && <span>{bitDepth}-bit</span>}
                            {FORMAT_INFO[format].lossy && <span>{bitRate} kbps</span>}
                        </div>
                    </div>

                    {/* ─── Progress ───────────────────────────────────────── */}
                    {(exporting || done) && (
                        <div className="space-y-2">
                            <div className="h-2 rounded-full bg-black/30 overflow-hidden">
                                <div
                                    className={cn(
                                        "h-full rounded-full transition-all duration-300",
                                        done ? "bg-emerald-500" : "bg-purple-500"
                                    )}
                                    style={{ width: `${progress}%` }}
                                />
                            </div>
                            <div className="flex items-center justify-between">
                                <span className={cn("text-[10px]", done ? "text-emerald-400" : "text-white/40")}>
                                    {done ? t("exportComplete", { size: exportedSize }) : t("rendering", { pct: progress.toFixed(0) })}
                                </span>
                                {exporting && <Loader2 className="h-3 w-3 text-purple-400 animate-spin" />}
                                {done && <Check className="h-3 w-3 text-emerald-400" />}
                            </div>
                        </div>
                    )}

                    {error && (
                        <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-[10px] text-red-400">
                            {error}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-4 py-3 border-t border-white/[0.06] flex items-center justify-between">
                    {/* Remember config */}
                    <label className="flex items-center gap-1.5 cursor-pointer group">
                        <input
                            type="checkbox"
                            checked={rememberConfig}
                            onChange={e => setRememberConfig(e.target.checked)}
                            disabled={exporting}
                            className="w-3.5 h-3.5 rounded border-white/20 bg-black/30 accent-purple-500"
                        />
                        <Save className="h-3 w-3 text-white/20 group-hover:text-white/40 transition-colors" />
                        <span className="text-[10px] text-white/30 group-hover:text-white/50 transition-colors">
                            {t("rememberSettings")}
                        </span>
                    </label>

                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleClose}
                            disabled={exporting}
                            className="h-8 px-4 rounded-lg text-xs text-white/40 hover:text-white/60 hover:bg-white/5 transition-colors disabled:opacity-30"
                        >
                            {t("cancel")}
                        </button>
                        {done && exportedBlob ? (
                            <button
                                onClick={handleDownload}
                                className="h-8 px-4 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded-lg transition-colors flex items-center gap-1.5"
                            >
                                <Download className="h-3.5 w-3.5" /> {t("download")} {FORMAT_INFO[format].ext}
                            </button>
                        ) : (
                            <button
                                onClick={handleExport}
                                disabled={exporting}
                                className="h-8 px-4 bg-purple-600 hover:bg-purple-500 text-white text-xs rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {exporting ? (
                                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("exporting")}</>
                                ) : (
                                    <><Download className="h-3.5 w-3.5" /> {t("export")}</>
                                )}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Helper Components ────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <label className="text-[10px] text-white/30 uppercase tracking-wider block mb-2">{label}</label>
            {children}
        </div>
    );
}

function DawSelect({ value, onChange, options, disabled }: {
    value: string | number;
    onChange: (v: string) => void;
    options: { value: string | number; label: string }[];
    disabled?: boolean;
}) {
    return (
        <div className="relative">
            <select
                value={value}
                onChange={e => onChange(e.target.value)}
                disabled={disabled}
                className={cn(
                    "w-full h-7 px-2 pr-6 rounded border text-[10px] appearance-none cursor-pointer transition-colors",
                    "bg-[#12122a] border-white/[0.08] text-white/60",
                    "hover:border-white/15 focus:outline-none focus:border-purple-500/40",
                    "disabled:opacity-40 disabled:cursor-not-allowed",
                    "[&>option]:bg-[var(--daw-bg)] [&>option]:text-[var(--daw-text-muted)]",
                )}
            >
                {options.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
            </select>
            <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-white/20 pointer-events-none" />
        </div>
    );
}

function MetaField({ label, value, onChange, disabled, placeholder }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    disabled?: boolean;
    placeholder?: string;
}) {
    return (
        <div>
            <label className="text-[8px] text-white/20 uppercase block mb-0.5">{label}</label>
            <input
                type="text"
                value={value}
                onChange={e => onChange(e.target.value)}
                disabled={disabled}
                placeholder={placeholder}
                className="w-full h-6 px-2 bg-[#12122a] border border-white/[0.08] rounded text-[10px] text-white/60 placeholder:text-white/15 focus:outline-none focus:border-purple-500/40 disabled:opacity-40"
            />
        </div>
    );
}

function DawCheckbox({ label, desc, checked, onChange, disabled }: {
    label: string;
    desc?: string;
    checked: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
}) {
    return (
        <label className="flex items-start gap-2 cursor-pointer group">
            <input
                type="checkbox"
                checked={checked}
                onChange={e => onChange(e.target.checked)}
                disabled={disabled}
                className="mt-0.5 w-3.5 h-3.5 rounded border-white/20 bg-black/30 accent-purple-500"
            />
            <div>
                <span className="text-[10px] text-white/50 group-hover:text-white/70 transition-colors">{label}</span>
                {desc && <p className="text-[8px] text-white/15 mt-0.5">{desc}</p>}
            </div>
        </label>
    );
}
