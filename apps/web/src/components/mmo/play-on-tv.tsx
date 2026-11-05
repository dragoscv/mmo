"use client";

/**
 * "Play on TV" (WP16-39): lists the hub devices that accept `play` (TVs, other browsers), excluding this
 * browser, and sends `cmd play {fileId, kind, tmdbId, season?, episode?, startSec?}` — the args tv-tizen
 * `App.tsx` and tv-android `MainActivity` accept (fileId required). When no `fileId` is given the best local
 * version is resolved first (same rules as the web player).
 *
 *   <PlayOnTvButton kind="movie" tmdbId={603} title="The Matrix" />   — popover picker (title pages)
 *   <TvDeviceList … onSent={…} />                                     — inline list (player side panel)
 */
import "./player/player.css";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Cast, Loader2, MonitorPlay, Tv } from "lucide-react";
import { Button, Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@mmo/ui";
import { ApiError } from "@/lib/mmo/api";
import { deviceId } from "@/lib/mmo/hub";
import type { HubDevice, MediaKind } from "@/lib/mmo/media-types";
import { useMmo } from "./mmo-provider";
import { playCommandArgs } from "./player/model";
import { resolvePlayback } from "./player/resolve";

export interface PlayOnTvProps {
    kind: MediaKind;
    tmdbId: number;
    title: string;
    fileId?: string;
    season?: number;
    episode?: number;
    positionSec?: number;
}

/** Devices that can be told to play: connected, not this browser, not a guest, advertising `play`. */
export function castableDevices(devices: readonly HubDevice[], selfId: string): HubDevice[] {
    return devices
        .filter((d) => d.deviceId !== selfId && !d.guest && Array.isArray(d.caps) && d.caps.includes("play"))
        .sort((a, b) => Number(isTv(b)) - Number(isTv(a)) || a.name.localeCompare(b.name));
}

export function isTv(d: Pick<HubDevice, "platform">): boolean {
    return /tizen|android-tv|androidtv|tv|webos/i.test(d.platform);
}

export type SendResult = { ok: true; device: HubDevice } | { ok: false; reason: "no_file" | "offline" | "timeout" | "rejected"; detail?: string };

/** Resolve (when needed) + send `play` to one device. Pure-ish: all I/O comes through `clients`. */
export function usePlayOnTv(p: PlayOnTvProps) {
    const { clients, devices } = useMmo();
    const [busy, setBusy] = useState<string | null>(null);
    const [selfId] = useState(() => (typeof window === "undefined" ? "" : deviceId()));
    const list = useMemo(() => castableDevices(devices, selfId), [devices, selfId]);

    const send = async (d: HubDevice): Promise<SendResult> => {
        if (!clients) return { ok: false, reason: "offline" };
        setBusy(d.deviceId);
        try {
            let fileId = p.fileId ?? null;
            let season = p.season ?? null;
            let episode = p.episode ?? null;
            let startSec = p.positionSec ?? null;
            if (!fileId) {
                const r = await resolvePlayback(clients.media, { kind: p.kind, tmdbId: p.tmdbId, season, episode, startSec });
                if (!r.ok) return { ok: false, reason: "no_file" };
                fileId = r.value.file.serverFileId;
                season = r.value.season;
                episode = r.value.episode;
                startSec = r.value.startSec;
            }
            const ack = await clients.hub.sendCommand(d.deviceId, "play", playCommandArgs({ fileId, kind: p.kind, tmdbId: p.tmdbId, season, episode, startSec, title: p.title }));
            if (!ack || ack.ok === false) return { ok: false, reason: ack?.error === "timeout" ? "timeout" : "rejected", detail: ack?.error };
            return { ok: true, device: d };
        } catch (e) {
            if (e instanceof ApiError) {
                if (e.status === 504) return { ok: false, reason: "timeout" };
                if (e.status === 404) return { ok: false, reason: "offline" };
                return { ok: false, reason: "rejected", detail: e.message };
            }
            return { ok: false, reason: "offline" };
        } finally {
            setBusy(null);
        }
    };
    return { list, busy, send };
}

export interface TvDeviceListProps extends PlayOnTvProps {
    /** Called after the TV acknowledged `play`. */
    onSent?(device: HubDevice): void;
}

export function TvDeviceList({ onSent, ...p }: TvDeviceListProps) {
    const t = useTranslations("mx.player.cast");
    const { hubStatus } = useMmo();
    const { list, busy, send } = usePlayOnTv(p);

    const pick = async (d: HubDevice) => {
        const r = await send(d);
        if (r.ok) {
            toast.success(t("sent", { device: d.name, title: p.title }));
            onSent?.(d);
            return;
        }
        toast.error(r.reason === "no_file" ? t("errNoFile") : r.reason === "timeout" ? t("errTimeout", { device: d.name })
            : r.reason === "offline" ? t("errOffline", { device: d.name }) : t("errRejected", { device: d.name, reason: r.detail ?? "?" }));
    };

    if (hubStatus !== "connected") {
        return <p className="mxp-muted" role="status">{hubStatus === "connecting" ? t("connecting") : t("hubOffline")}</p>;
    }
    if (list.length === 0) {
        return (
            <div className="mxp-cast-empty">
                <Tv aria-hidden className="size-6" />
                <p>{t("empty")}</p>
                <p className="mxp-muted">{t("emptyHint")}</p>
            </div>
        );
    }
    return (
        <ul className="mxp-cast-list" aria-label={t("devices")}>
            {list.map((d) => {
                const playing = d.nowPlaying?.media?.title;
                return (
                    <li key={d.deviceId}>
                        <button type="button" className="mxp-cast-item" onClick={() => { void pick(d); }} disabled={busy !== null} aria-busy={busy === d.deviceId || undefined}>
                            {busy === d.deviceId ? <Loader2 aria-hidden className="size-5 mxp-spin" /> : isTv(d) ? <Tv aria-hidden className="size-5" /> : <MonitorPlay aria-hidden className="size-5" />}
                            <span className="mxp-cast-text">
                                <span className="mxp-cast-name">{d.name}</span>
                                <span className="mxp-cast-sub">{playing ? t("nowPlaying", { title: playing }) : t("idle")}</span>
                            </span>
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}

/** Compact button + popover picker for title / episode rows. Hidden while the hub has no castable devices. */
export function PlayOnTvButton(p: PlayOnTvProps & { size?: "default" | "sm" | "lg"; variant?: "outline" | "secondary" | "ghost" }) {
    const t = useTranslations("mx.player.cast");
    const { devices } = useMmo();
    const [selfId] = useState(() => (typeof window === "undefined" ? "" : deviceId()));
    const [open, setOpen] = useState(false);
    const any = castableDevices(devices, selfId).length > 0;
    if (!any) return null;
    const { size = "default", variant = "outline", ...rest } = p;
    return (
        <Popover open={open} onOpenChange={(o) => setOpen(o)}>
            <PopoverTrigger render={<Button variant={variant} size={size} aria-label={t("buttonLabel", { title: p.title })} />}>
                <Cast aria-hidden />
                <span>{t("button")}</span>
            </PopoverTrigger>
            <PopoverContent align="start" className="mxp-cast-popover">
                <PopoverTitle className="mxp-section-title">{t("title")}</PopoverTitle>
                <TvDeviceList {...rest} onSent={() => setOpen(false)} />
            </PopoverContent>
        </Popover>
    );
}
