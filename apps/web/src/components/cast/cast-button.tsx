"use client";

/**
 * "Play on…" picker — one button, three back-ends:
 *   - Google Cast from this browser (Web Sender SDK, Chrome only)
 *   - DLNA renderers discovered by the companion
 *   - Home Assistant media players (incl. Cast devices exposed via HA)
 *
 * Used in the video overlay (`variant="video"`, matches the host buttons)
 * and the audio bar (`variant="audio"`, plain icon). While a remote
 * session is active a "Playing on <name>" pill with pause/stop replaces
 * the picker.
 */

import { useCallback, useEffect, useState } from "react";
import { Cast, Pause, Play, Square, RefreshCw, Loader2, Tv, HomeIcon } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { listCastDevices, castToDevice, castCommand, getRendererMediaUrls } from "@/actions/cast";
import type { CastDevice } from "@/lib/cast/companion-cast";
import * as gcast from "@/lib/cast/google-cast";

export type CastMediaRef =
    | { type: "video"; fileId: number }
    | { type: "track"; trackId: number };

export interface CastButtonProps {
    media: CastMediaRef | null;
    /** Current playhead (s) — remote playback resumes from here. */
    currentTime?: number;
    variant: "video" | "audio";
    /** Called after a remote session starts so the local player can pause. */
    onRemoteStart?: () => void;
    style?: React.CSSProperties;
    className?: string;
}

type RemoteSession = { deviceId: string; name: string; kind: "browser-cast" | "remote"; paused: boolean };

const KIND_ORDER: Array<CastDevice["kind"]> = ["google-cast-ha", "dlna", "home-assistant"];

function KindIcon({ kind }: { kind: CastDevice["kind"] }) {
    if (kind === "dlna") return <Tv className="h-3.5 w-3.5" />;
    if (kind === "google-cast-ha") return <Cast className="h-3.5 w-3.5" />;
    return <HomeIcon className="h-3.5 w-3.5" />;
}

const hostBtnStyle: React.CSSProperties = {
    background: "rgba(0,0,0,0.7)",
    color: "#fff",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 8,
    padding: "6px 8px",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
};

export function CastButton({ media, currentTime = 0, variant, onRemoteStart, style, className }: CastButtonProps) {
    const t = useTranslations("cast");
    const [open, setOpen] = useState(false);
    const [castState, setCastState] = useState<gcast.CastState>("unavailable");
    const [devices, setDevices] = useState<CastDevice[] | null>(null);
    const [haConfigured, setHaConfigured] = useState(true);
    const [loading, setLoading] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [session, setSession] = useState<RemoteSession | null>(null);

    useEffect(() => {
        let unsub: (() => void) | null = null;
        void gcast.ensureCastSdk().then((ok) => {
            if (ok) unsub = gcast.subscribeCastState(setCastState);
        });
        return () => { unsub?.(); };
    }, []);

    // Browser Cast session ended from the Chrome UI → the pill disappears.
    // Derived during render (no setState-in-effect); the stale `session`
    // object is cleared lazily the next time the user casts.
    const activeSession = session && (session.kind !== "browser-cast" || castState === "connected" || castState === "connecting")
        ? session
        : null;

    const refresh = useCallback(async (force = false) => {
        setLoading(true);
        setError(null);
        const r = await listCastDevices(force);
        setLoading(false);
        if (!r.ok) { setError(r.error); setDevices([]); return; }
        setDevices(r.data.devices);
        setHaConfigured(r.data.haConfigured);
    }, []);

    const onOpenChange = useCallback((next: boolean) => {
        setOpen(next);
        if (next && devices === null) void refresh(false);
    }, [devices, refresh]);

    const browserCastAvailable = castState !== "unavailable";
    const disabled = !media;

    const castViaBrowser = useCallback(async () => {
        if (!media) return;
        setBusyId("chromecast:web");
        try {
            await gcast.requestSession();
            const urls = await getRendererMediaUrls({ media, kind: "google-cast" });
            if (!urls.ok) throw new Error(urls.error);
            await gcast.loadMedia({
                url: urls.data.url,
                mime: urls.data.mime,
                title: urls.data.title,
                subtitle: urls.data.subtitle,
                poster: urls.data.poster,
                tracks: urls.data.subtitles,
                activeTrack: urls.data.subtitles.length ? 0 : undefined,
                startSec: currentTime,
            });
            const name = gcast.currentDeviceName() ?? "Chromecast";
            setSession({ deviceId: "chromecast:web", name, kind: "browser-cast", paused: false });
            onRemoteStart?.();
            toast.success(t("playingOn", { name }));
            setOpen(false);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // User closed the Chrome picker — not an error worth a toast.
            if (!/cancel/i.test(msg)) toast.error(t("castFailed", { error: msg }));
        } finally {
            setBusyId(null);
        }
    }, [media, currentTime, onRemoteStart, t]);

    const castToRemote = useCallback(async (d: CastDevice) => {
        if (!media) return;
        setBusyId(d.id);
        const r = await castToDevice({ deviceId: d.id, media, startSec: currentTime > 3 ? currentTime : undefined });
        setBusyId(null);
        if (!r.ok) { toast.error(t("castFailed", { error: r.error })); return; }
        setSession({ deviceId: d.id, name: d.name, kind: "remote", paused: false });
        onRemoteStart?.();
        toast.success(t("playingOn", { name: d.name }));
        setOpen(false);
    }, [media, currentTime, onRemoteStart, t]);

    const remoteCmd = useCallback(async (action: "play" | "pause" | "stop") => {
        if (!activeSession) return;
        if (activeSession.kind === "browser-cast") {
            if (action === "stop") { gcast.stop(); setSession(null); return; }
            if (action === "pause") gcast.pause(); else gcast.play();
            setSession({ ...activeSession, paused: action === "pause" });
            return;
        }
        const r = await castCommand({ deviceId: activeSession.deviceId, action });
        if (!r.ok) { toast.error(t("castFailed", { error: r.error })); return; }
        if (action === "stop") setSession(null);
        else setSession({ ...activeSession, paused: action === "pause" });
    }, [activeSession, t]);

    const triggerStyle = variant === "video" ? { ...hostBtnStyle, ...style } : style;
    const triggerClass = variant === "audio"
        ? cn("text-muted-foreground hover:text-foreground transition-colors duration-200 cursor-pointer disabled:opacity-40", className)
        : className;

    if (activeSession) {
        const session = activeSession;
        const pill = variant === "video"
            ? { ...hostBtnStyle, padding: "4px 8px", fontSize: 12, gap: 6 }
            : undefined;
        return (
            <div
                style={pill}
                className={variant === "audio" ? "flex items-center gap-1.5 px-2 py-1 rounded-lg bg-primary/15 text-foreground text-[11px]" : undefined}
                title={t("playingOn", { name: session.name })}
            >
                <Cast className="h-3.5 w-3.5 text-primary" />
                <span className="max-w-[120px] truncate">{session.name}</span>
                <button type="button" onClick={() => void remoteCmd(session.paused ? "play" : "pause")} aria-label={session.paused ? t("resume") : t("pause")} className="cursor-pointer opacity-80 hover:opacity-100">
                    {session.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                </button>
                <button type="button" onClick={() => void remoteCmd("stop")} aria-label={t("stop")} className="cursor-pointer opacity-80 hover:opacity-100">
                    <Square className="h-3 w-3" />
                </button>
            </div>
        );
    }

    const grouped = KIND_ORDER
        .map((kind) => ({ kind, items: (devices ?? []).filter((d) => d.kind === kind) }))
        .filter((g) => g.items.length > 0);
    const empty = !loading && !browserCastAvailable && (devices?.length ?? 0) === 0;

    return (
        <Popover open={open} onOpenChange={onOpenChange}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    disabled={disabled}
                    title={t("playOn")}
                    aria-label={t("playOn")}
                    style={triggerStyle}
                    className={triggerClass}
                >
                    <Cast className={variant === "video" ? undefined : "h-4 w-4"} size={variant === "video" ? 14 : undefined} />
                </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 gap-2 p-2" initialFocus={false}>
                <div className="flex items-center justify-between px-1">
                    <span className="text-xs font-medium">{t("playOn")}</span>
                    <button
                        type="button"
                        onClick={() => void refresh(true)}
                        disabled={loading}
                        aria-label={t("refresh")}
                        title={t("refresh")}
                        className="text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-40"
                    >
                        <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
                    </button>
                </div>

                {browserCastAvailable && (
                    <DeviceRow
                        icon={<Cast className="h-3.5 w-3.5" />}
                        name={t("browserCast")}
                        hint={castState === "no-devices" ? t("noCastDevices") : undefined}
                        busy={busyId === "chromecast:web"}
                        disabled={castState === "no-devices" || busyId !== null}
                        onClick={() => void castViaBrowser()}
                    />
                )}

                {grouped.map((g) => (
                    <div key={g.kind} className="flex flex-col gap-0.5">
                        <div className="px-1 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">{t(`kind.${g.kind}`)}</div>
                        {g.items.map((d) => (
                            <DeviceRow
                                key={d.id}
                                icon={<KindIcon kind={d.kind} />}
                                name={d.name}
                                hint={d.state && d.state !== "idle" && d.state !== "off" ? d.state : d.model}
                                busy={busyId === d.id}
                                disabled={busyId !== null}
                                onClick={() => void castToRemote(d)}
                            />
                        ))}
                    </div>
                ))}

                {loading && devices === null && (
                    <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("searching")}
                    </div>
                )}
                {empty && <div className="px-1 py-2 text-xs text-muted-foreground">{t("noDevices")}</div>}
                {error && <div className="px-1 text-xs text-destructive">{error}</div>}
                {devices !== null && !haConfigured && (
                    <div className="px-1 text-[10px] text-muted-foreground">{t("haNotConfigured")}</div>
                )}
            </PopoverContent>
        </Popover>
    );
}

function DeviceRow({ icon, name, hint, busy, disabled, onClick }: {
    icon: React.ReactNode; name: string; hint?: string; busy: boolean; disabled: boolean; onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent disabled:opacity-50 cursor-pointer"
        >
            <span className="text-muted-foreground">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}</span>
            <span className="flex-1 truncate">{name}</span>
            {hint && <span className="truncate max-w-[90px] text-[10px] text-muted-foreground">{hint}</span>}
        </button>
    );
}
