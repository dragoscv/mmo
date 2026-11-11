"use client";

/**
 * `SendQueueToTv` — "Play on TV" for music: a button + popover listing the hub devices that take a music
 * queue (`music` cap: MixAI TV on Google TV / Tizen, MixAI Music on a phone). One click on a device saves the
 * queue on the server, sends hub `cmd play {trackIds, index, positionSec, shuffle, repeat}` (shape and
 * receivers: `send-to-tv.ts`) and, once the device acknowledged, pauses this browser.
 * Always rendered (an empty hub explains how to get a TV listed) so the feature is discoverable.
 * Strings: `mx.music.tv.{button,title,sent,errEmpty,errNotFound}`; the device list and the generic errors
 * reuse `mx.player.cast.*` (same wording as "Play on TV" for films).
 */
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Cast } from "lucide-react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@mmo/ui";
import type { HubDevice } from "@/lib/mmo/media-types";
import { webMusicPlayer } from "@/lib/mmo/web-music-player";
import { useMmo } from "../mmo-provider";
import { HubDevicePicker, tvFirst, useSelfDeviceId } from "../play-on-tv";
import { handQueueToDevice, musicTargets } from "./send-to-tv";

export function SendQueueToTv({ className = "mu-chip" }: { className?: string }) {
    const t = useTranslations("mx.music.tv");
    const tc = useTranslations("mx.player.cast");
    const { clients, devices } = useMmo();
    const selfId = useSelfDeviceId();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const list = useMemo(() => musicTargets(devices, selfId).sort(tvFirst), [devices, selfId]);

    const pick = async (d: HubDevice) => {
        if (!clients || busy !== null) return;
        const st = webMusicPlayer.getState();
        setBusy(d.deviceId);
        const r = await handQueueToDevice(
            { saveQueue: (q) => clients.music.setQueue(q), command: (id, action, args) => clients.hub.commandAwait(id, action, args) },
            d.deviceId,
            { queue: st.queue, index: st.index, positionSec: webMusicPlayer.getProgress().position, shuffle: st.shuffle, repeat: st.repeat },
        );
        setBusy(null);
        if (r.ok) {
            // The TV plays from here on; keep the queue so "Play" resumes in this browser.
            webMusicPlayer.pause();
            toast.success(t("sent", { device: d.name }));
            setOpen(false);
            return;
        }
        toast.error(r.reason === "empty" ? t("errEmpty") : r.reason === "not_found" ? t("errNotFound", { device: d.name })
            : r.reason === "timeout" ? tc("errTimeout", { device: d.name }) : r.reason === "offline" ? tc("errOffline", { device: d.name })
                : tc("errRejected", { device: d.name, reason: r.detail ?? "?" }));
    };

    return (
        <Popover open={open} onOpenChange={(o) => setOpen(o)}>
            <PopoverTrigger render={<button type="button" className={className} data-testid="music-send-to-tv" />}>
                <Cast aria-hidden className="size-4" />
                <span>{t("button")}</span>
            </PopoverTrigger>
            <PopoverContent align="end" className="mxp-cast-popover">
                <PopoverTitle className="mxp-section-title">{t("title")}</PopoverTitle>
                <HubDevicePicker list={list} busy={busy} onPick={(d) => { void pick(d); }} />
            </PopoverContent>
        </Popover>
    );
}
