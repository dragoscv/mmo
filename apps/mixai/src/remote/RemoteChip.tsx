/**
 * Status-bar item of connected mode (rendered by shell/StatusBar.tsx): "CONNECT" + a state dot,
 * and while the server runs the number of connected devices and of song requests waiting.
 * Clicking opens the popover (start / stop, pairing codes, requests, devices).
 *
 * Subscribes to a few small values that change only when a device joins or a request arrives.
 *
 * The chip is the only way into connected mode. The status-bar fit hides items that carry
 * `data-prio` when the bar is narrow, so the chip carries it only while the server is off:
 * a running server (and requests waiting on it) can always be reached and stopped.
 */
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ListMusic, Lock, Smartphone } from "lucide-react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@mmo/ui";
import { useT } from "@/i18n";
import { consumeBareArrows, countStatus } from "./remote-core";
import { startRemote, useRemoteStore } from "./remote-store";

const RemotePopover = lazy(() => import("./RemotePopover").then((m) => ({ default: m.RemotePopover })));

/** Hidden by the status-bar fit before the library link (40) when the bar is narrow; only while the server is off. */
const PRIO = 45;
/** How long the text of a new request stays in the live region (a later identical one is announced again). */
const ANNOUNCE_MS = 6000;

/**
 * ONE polite live region for connected mode: it speaks when a new request arrives (the store
 * bumps `arrived.seq` once per arrival, not on every state event) and is empty otherwise.
 * It lives here, not in the popover, because requests arrive while the popover is closed.
 */
function Arrivals() {
    const t = useT();
    const arrived = useRemoteStore((s) => s.arrived);
    // The arrival being announced; cleared after a while so the region is empty between two.
    const [shown, setShown] = useState(arrived);
    useEffect(() => {
        setShown(arrived);
        if (!arrived) return;
        const id = setTimeout(() => setShown(null), ANNOUNCE_MS);
        return () => clearTimeout(id);
    }, [arrived]);
    return (
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-remote-live>
            {shown ? t("remote.arrived", { song: shown.artist ? `${shown.title} · ${shown.artist}` : shown.title }) : ""}
        </span>
    );
}

export function RemoteChip() {
    const t = useT();
    const availability = useRemoteStore((s) => s.availability);
    const running = useRemoteStore((s) => s.running);
    const locked = useRemoteStore((s) => s.controlsLocked);
    const clients = useRemoteStore((s) => s.clients.length);
    const pending = useRemoteStore((s) => countStatus(s.requests, "pending"));
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLButtonElement>(null);
    useEffect(() => startRemote(), []);
    // The fit only un-hides items it still manages: when the chip stops being one of them
    // (the server started, perhaps from another window, while the chip was hidden) it shows
    // itself; the size change makes the fit run again and hide something less important.
    useLayoutEffect(() => {
        if (running && ref.current?.hidden) ref.current.hidden = false;
    }, [running]);
    const unavailable = availability === "preview" || availability === "old";
    const label = unavailable ? t("remote.chipAriaNa") : running ? `${t("remote.chipAriaOn", { clients, pending })}${locked ? ` ${t("remote.chipLocked")}` : ""}` : t("remote.chipAriaOff");
    return (
        <>
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger ref={ref} className="sb-item rm-chip" data-prio={running ? undefined : PRIO} data-on={running} aria-label={label} title={t("remote.chipTip")}>
                    <i className="sb-dot" data-state={running ? "online" : "offline"} />
                    <span className="dk-label">{t("remote.chip")}</span>
                    {running && (
                        <span className="rm-chip-count">
                            <Smartphone size={10} aria-hidden />
                            <span className="dk-num dk-num-sm">{clients}</span>
                        </span>
                    )}
                    {running && locked && <Lock className="rm-chip-lock" size={10} aria-hidden />}
                    {running && pending > 0 && (
                        <span className="rm-chip-count rm-badge">
                            <ListMusic size={10} aria-hidden />
                            <span className="dk-num dk-num-sm">{pending}</span>
                        </span>
                    )}
                </PopoverTrigger>
                {/* Bare arrows are the app's crossfader shortcuts: none may leave the popover unused. */}
                <PopoverContent
                    side="top"
                    align="end"
                    className="rm-pop"
                    onKeyDown={(e) => {
                        consumeBareArrows(e);
                    }}
                >
                    <PopoverTitle className="dk-label">{t("remote.title")}</PopoverTitle>
                    {open && (
                        <Suspense fallback={null}>
                            <RemotePopover />
                        </Suspense>
                    )}
                </PopoverContent>
            </Popover>
            <Arrivals />
        </>
    );
}
