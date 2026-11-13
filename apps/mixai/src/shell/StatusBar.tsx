/**
 * Permanent status bar under the workspace (one row, `--statusbar-h`). Lives in the shell grid
 * (see App.tsx); never wraps or scrolls: when the row is too narrow the optional items
 * (`data-prio`, highest first) are hidden, from the right end of the bar towards the left.
 *
 * Left: engine state · master level · audio load · sample rate + buffer (+ output device).
 * Right: library connection · local time · skin / layout.
 *
 * Idle is free: every part subscribes to ONE value that is quantised before it reaches React
 * (meter cells, whole percent with a dead band, the minute), see ./status-math and
 * ./status-store. With the decks stopped nothing here renders.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useMixerStore } from "@/state/mixer-store";
import { useUiStore, type SettingsTab } from "@/state/ui-store";
import { useAllLayouts, useLayoutStore } from "@/layout/layout-store";
import { layoutName } from "@/layout/presets";
import { BUILTIN_SKINS } from "@/packs/builtin-skins";
import { skinName } from "@/packs/skin-text";
import { usePackStore } from "@/packs/pack-store";
import { useT, type MessageKey } from "@/i18n";
import { GigChip } from "@/gig/GigChip";
import { lockedTip } from "@/gig/gig-core";
import { useGigLocked } from "@/gig/gig-store";
import { LinkChip } from "@/link/LinkChip";
import { PracticeChip } from "@/practice/PracticeChip";
import { RemoteChip } from "@/remote/RemoteChip";
import { startStatus, useStatusStore, type CompanionLink } from "./status-store";
import { LOAD_CELLS, VU_CELLS, VU_FLOOR_DB, bufferFrames, clockText, loadCells, loadLevel, msToNextMinute, overrunText, shortDevice, vuCells, vuCellsDb } from "./status-math";

/** Hide order when the bar is too narrow: the highest number goes first. */
const PRIO = { look: 70, device: 60, clock: 50, library: 40, audio: 30, engineText: 20 } as const;

/** Meter cells never change; the container's `data-lit` says how many are lit (shell.css). */
const VU_ZONES = Array.from({ length: VU_CELLS }, (_, i) => (i >= VU_CELLS - 1 ? "alert" : i >= VU_CELLS - 4 ? "warn" : undefined));
const LOAD_SLOTS = Array.from({ length: LOAD_CELLS }, (_, i) => i);

/**
 * Keep the row inside the bar: show every optional part, then hide them by priority until the
 * content fits. Runs on resize and when a part changes width, never on a timer.
 */
function useFit(ref: RefObject<HTMLElement | null>): void {
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === "undefined") return;
        const fit = () => {
            const parts = [...el.querySelectorAll<HTMLElement>("[data-prio]")].sort((a, b) => Number(b.dataset.prio) - Number(a.dataset.prio));
            for (const p of parts) if (p.hidden) p.hidden = false;
            for (const p of parts) {
                if (el.scrollWidth <= el.clientWidth) break;
                p.hidden = true;
            }
        };
        fit();
        const ro = new ResizeObserver(fit);
        ro.observe(el);
        for (const c of el.children) ro.observe(c);
        return () => ro.disconnect();
    });
}

function SettingsItem({ tab, prio, label, title, className, children, ...data }: { tab: SettingsTab; prio?: number; label?: string; title: string; className?: string; children: ReactNode; "data-level"?: string; "data-state"?: string }) {
    // Gig lock: the item stays focusable and readable; pressing it says why Settings stay closed (ui-store asks the gate).
    const locked = useGigLocked();
    const t = useT();
    // ...and its tooltip must not promise "Click for the ... settings" while that door is locked.
    const tip = locked ? lockedTip(title, t("gig.lockedShort")) : title;
    return (
        <button type="button" className={"sb-item " + (className ?? "")} data-prio={prio} aria-label={label} aria-disabled={locked || undefined} title={tip} onClick={() => useUiStore.getState().openSettings(tab)} {...data}>
            {children}
        </button>
    );
}

/** Master output level: 16 cells of 3 dB, the top one = above -3 dBFS. */
function MasterVu() {
    const t = useT();
    const lit = useMixerStore((s) => vuCells(s.masterVu));
    const db = vuCellsDb(lit);
    return (
        <span className="sb-item">
            <span className="dk-label" aria-hidden>
                {t("shell.sb.master")}
            </span>
            <span
                className="sb-cells"
                role="meter"
                data-lit={lit}
                aria-label={t("shell.sb.masterAria")}
                aria-valuemin={VU_FLOOR_DB}
                aria-valuemax={0}
                aria-valuenow={db ?? VU_FLOOR_DB}
                aria-valuetext={db === null ? t("shell.sb.silence") : t("shell.sb.dbfs", { db })}
            >
                {VU_ZONES.map((zone, i) => (
                    <i key={i} data-zone={zone} />
                ))}
            </span>
        </span>
    );
}

/**
 * Audio callback load: 5 cells + percent; words from 70 % and 100 %; x-runs only when there are
 * any. The visible text IS the accessible name (no aria-label, a fixed tooltip), so a change of
 * the number touches one text node and nothing else.
 */
function AudioLoad() {
    const t = useT();
    const pct = useStatusStore((s) => s.loadPct);
    const overruns = useStatusStore((s) => s.overruns);
    const level = loadLevel(pct);
    const lit = loadCells(pct);
    const word = level === "alert" ? t("shell.sb.loadOver") : level === "warn" ? t("shell.sb.loadHigh") : "";
    return (
        <SettingsItem tab="audio" className="sb-load" data-level={level} title={`${t("shell.sb.loadTip")} ${overruns > 0 ? t("shell.sb.xrunsTip") + " " : ""}${t("shell.sb.openAudio")}`}>
            <span className="dk-label">{t("shell.sb.load")}</span>
            <span className="sb-cells sb-cells-load" data-lit={lit} aria-hidden>
                {LOAD_SLOTS.map((i) => (
                    <i key={i} />
                ))}
            </span>
            <span className="dk-num dk-num-sm sb-pct">{t("shell.sb.pct", { n: pct })}</span>
            {word && <strong className="sb-word">{word}</strong>}
            {overruns > 0 && <span className="dk-num dk-num-sm sb-xruns">{t("shell.sb.xruns", { n: overrunText(overruns) })}</span>}
        </SettingsItem>
    );
}

/** Sample rate + buffer latency (+ the opened output device when there is room). */
function AudioInfo() {
    const t = useT();
    const sampleRate = useMixerStore((s) => s.sampleRate);
    const latencyMs = useStatusStore((s) => s.latencyMs);
    const device = useStatusStore((s) => s.device);
    const khz = (sampleRate / 1000).toFixed(1);
    const ms = latencyMs.toFixed(1);
    const tip = t("shell.sb.audioTip", { khz, frames: bufferFrames(latencyMs, sampleRate), ms });
    return (
        <SettingsItem tab="audio" prio={PRIO.audio} label={device ? `${t("shell.sb.outputDevice", { device })}. ${tip}` : tip} title={device ? `${t("shell.sb.outputDevice", { device })}\n${tip}` : tip}>
            <span className="dk-num dk-num-sm">{t("shell.sb.khz", { khz })}</span>
            <span className="dk-label">{t("shell.sb.buf")}</span>
            <span className="dk-num dk-num-sm">{t("shell.sb.ms", { ms })}</span>
            {device && (
                <span className="sb-device" data-prio={PRIO.device}>
                    {shortDevice(device)}
                </span>
            )}
        </SettingsItem>
    );
}

const LINK_TEXT: Record<CompanionLink, MessageKey> = { online: "shell.sb.libOnline", unpaired: "shell.sb.libUnpaired", offline: "shell.sb.libOffline" };
const LINK_TIP: Record<CompanionLink, MessageKey> = { online: "shell.sb.libOnlineTip", unpaired: "shell.sb.libUnpairedTip", offline: "shell.sb.libOfflineTip" };

/** Companion (library) connection; probed every 15 s by the status store. */
function LibraryLink() {
    const t = useT();
    const link = useStatusStore((s) => s.companion);
    if (link === null) return null;
    return (
        <SettingsItem tab="library" prio={PRIO.library} data-state={link} label={`${t(LINK_TEXT[link])}. ${t(LINK_TIP[link])}`} title={t(LINK_TIP[link])}>
            <i className="sb-dot" data-state={link} />
            <span>{t(LINK_TEXT[link])}</span>
        </SettingsItem>
    );
}

/** Local time HH:MM; one timer per minute. */
function Clock() {
    const t = useT();
    const [text, setText] = useState(() => clockText(new Date()));
    useEffect(() => {
        let id: ReturnType<typeof setTimeout>;
        const tick = () => {
            const now = new Date();
            setText(clockText(now));
            id = setTimeout(tick, msToNextMinute(now));
        };
        tick();
        return () => clearTimeout(id);
    }, []);
    return (
        <time className="sb-item dk-num dk-num-sm sb-clock" data-prio={PRIO.clock} title={t("shell.sb.clock")}>
            {text}
        </time>
    );
}

/** Active skin and layout. */
function LookInfo() {
    const t = useT();
    const activeSkin = usePackStore((s) => s.activeSkin);
    const installed = usePackStore((s) => s.installed);
    const activeId = useLayoutStore((s) => s.activeId);
    const layouts = useAllLayouts();
    const pack = activeSkin ? (BUILTIN_SKINS.find((p) => p.manifest.id === activeSkin) ?? installed.find((p) => p.manifest.id === activeSkin)) : undefined;
    const skin = pack ? skinName(t, pack) : t("shell.sb.skinDefault");
    const current = layouts.find((l) => l.id === activeId);
    const layout = current ? layoutName(t, current) : t("shell.layout");
    const tip = t("shell.sb.lookTip", { skin, layout });
    return (
        <SettingsItem tab="appearance" prio={PRIO.look} className="sb-look" label={tip} title={tip}>
            <span className="sb-ellipsis">{skin}</span>
            <span className="sb-sep" />
            <span className="sb-ellipsis">{layout}</span>
        </SettingsItem>
    );
}

export function StatusBar() {
    const t = useT();
    const native = useMixerStore((s) => s.native);
    // Re-run the fit when the library item appears (its first probe answered).
    useStatusStore((s) => s.companion !== null);
    const ref = useRef<HTMLElement>(null);
    useEffect(() => startStatus(), []);
    useFit(ref);
    return (
        <footer ref={ref} className="mixai-statusbar sb" aria-label={t("shell.statusBar")}>
            <span className="sb-item sb-engine" data-state={native ? "online" : "offline"} title={native ? undefined : t("shell.sb.previewTip")}>
                <i className="sb-dot" data-state={native ? "online" : "offline"} />
                <span data-prio={PRIO.engineText}>{native ? t("shell.sb.engineNative") : t("shell.sb.enginePreview")}</span>
            </span>
            <MasterVu />
            {native && <AudioLoad />}
            {native && <AudioInfo />}
            <span className="sb-spacer" />
            <GigChip />
            <PracticeChip />
            <LinkChip />
            <RemoteChip />
            <LibraryLink />
            <Clock />
            <LookInfo />
        </footer>
    );
}
