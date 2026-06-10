"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Volume2, VolumeX } from "lucide-react";
import { getStemUrls, type StemKind } from "@/actions/stems";

const LABELS: Record<StemKind, string> = {
    vocals: "Vocals",
    drums: "Drums",
    bass: "Bass",
    other: "Other",
};

const COLORS: Record<StemKind, string> = {
    vocals: "#ec4899",
    drums: "#f97316",
    bass: "#a855f7",
    other: "#06b6d4",
};

interface Props {
    stemTrackId: number;
}

export function StemsMiniPlayers({ stemTrackId }: Props) {
    const [urls, setUrls] = useState<Record<StemKind, string> | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [muted, setMuted] = useState<Record<StemKind, boolean>>({ vocals: false, drums: false, bass: false, other: false });
    const [soloed, setSoloed] = useState<Record<StemKind, boolean>>({ vocals: false, drums: false, bass: false, other: false });
    const refs = useRef<Record<StemKind, HTMLAudioElement | null>>({ vocals: null, drums: null, bass: null, other: null });

    useEffect(() => {
        let cancelled = false;
        getStemUrls(stemTrackId)
            .then((u) => { if (!cancelled) setUrls(u); })
            .catch((e: unknown) => { if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load stems"); });
        return () => { cancelled = true; };
    }, [stemTrackId]);

    const anySolo = useMemo(() => Object.values(soloed).some(Boolean), [soloed]);

    useEffect(() => {
        (Object.keys(LABELS) as StemKind[]).forEach((k) => {
            const el = refs.current[k];
            if (!el) return;
            const audible = anySolo ? soloed[k] && !muted[k] : !muted[k];
            el.muted = !audible;
        });
    }, [muted, soloed, anySolo]);

    if (err) return <p className="text-xs text-destructive">{err}</p>;
    if (!urls) return <p className="text-xs text-muted-foreground">Loading stems…</p>;

    const playAll = () => {
        (Object.keys(LABELS) as StemKind[]).forEach((k) => {
            const el = refs.current[k];
            if (el) { el.currentTime = 0; void el.play(); }
        });
    };
    const pauseAll = () => {
        (Object.keys(LABELS) as StemKind[]).forEach((k) => {
            refs.current[k]?.pause();
        });
    };

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <button
                    onClick={playAll}
                    className="h-7 px-2 rounded text-xs bg-white/5 hover:bg-white/10 text-white/80"
                >
                    Play all
                </button>
                <button
                    onClick={pauseAll}
                    className="h-7 px-2 rounded text-xs bg-white/5 hover:bg-white/10 text-white/80"
                >
                    Pause all
                </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
                {(Object.keys(LABELS) as StemKind[]).map((k) => (
                    <div key={k} className="flex flex-col gap-1 rounded border border-white/5 bg-white/[0.02] p-1.5">
                        <div className="flex items-center gap-1.5">
                            <span
                                className="h-2 w-2 rounded-full"
                                style={{ background: COLORS[k] }}
                            />
                            <span className="text-[10px] uppercase tracking-wider text-muted-foreground flex-1">{LABELS[k]}</span>
                            <button
                                title={muted[k] ? "Unmute" : "Mute"}
                                onClick={() => setMuted((m) => ({ ...m, [k]: !m[k] }))}
                                className="h-5 w-5 rounded hover:bg-white/10 text-white/60 flex items-center justify-center"
                            >
                                {muted[k] ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
                            </button>
                            <button
                                title={soloed[k] ? "Unsolo" : "Solo"}
                                onClick={() => setSoloed((s) => ({ ...s, [k]: !s[k] }))}
                                className={`h-5 px-1 rounded text-[9px] font-bold ${soloed[k] ? "bg-yellow-500/30 text-yellow-300" : "bg-white/5 text-white/40 hover:bg-white/10"}`}
                            >
                                S
                            </button>
                            <a
                                href={urls[k]}
                                download={`${LABELS[k].toLowerCase()}.wav`}
                                title={`Download ${LABELS[k]}`}
                                className="h-5 w-5 rounded hover:bg-white/10 text-white/60 flex items-center justify-center"
                            >
                                <Download className="h-3 w-3" />
                            </a>
                        </div>
                        <audio
                            ref={(el) => { refs.current[k] = el; }}
                            controls
                            src={urls[k]}
                            preload="none"
                            className="w-full h-8"
                        />
                    </div>
                ))}
            </div>
        </div>
    );
}
