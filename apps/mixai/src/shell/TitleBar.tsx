/**
 * Custom title bar (replaces the native one; WP19-30).
 *
 * - Windows / Linux: native decorations are removed in Rust setup; this bar
 *   draws the drag region and minimize / maximize / close. Hovering maximize on
 *   Windows 11 opens the Snap Layouts flyout (`window_show_snap_overlay`).
 * - macOS: titleBarStyle Overlay keeps the traffic lights; we only leave room
 *   for them on the left (no own buttons).
 * - Browser preview: no window buttons.
 *
 * Drag: every non-interactive part of the bar carries `data-tauri-drag-region`
 * (Tauri only drags on the element itself, not its children); double-click
 * toggles maximize (Tauri handles it on drag regions).
 *
 * Decks 1.5 look: one flat 36 px row, controls are `dk-btn` (styles: shell.css `.tb-*`). The
 * engine state and the "kHz · ms" readout live in the status bar (StatusBar.tsx).
 */
import { useEffect, useRef, useState } from "react";
import { Circle, Command, Expand, Keyboard, LayoutGrid, Minimize2, Minus, Settings, Shrink, Square, Theater, X, ZoomIn } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    KbdCombo,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@mmo/ui";
import { platform, windowCtl } from "@/bridge/window";
import { useMixerStore } from "@/state/mixer-store";
import { useUiStore } from "@/state/ui-store";
import { useRecordingStore } from "@/state/recording-store";
import { useAllLayouts, useLayoutStore } from "@/layout/layout-store";
import { openLayoutEditor } from "@/layout/editor-bridge";
import { layoutName } from "@/layout/presets";
import { ProfileSwitcher } from "@/settings/ProfileSwitcher";
import { useT } from "@/i18n";
import { PerfHud } from "./PerfHud";
import { useShellPrefs } from "./shell-prefs";
import { recTime } from "./status-math";

const os = platform();

export function TitleBar() {
    const t = useT();
    const native = useMixerStore((s) => s.native);
    const stage = useUiStore((s) => s.stage);
    const setStage = useUiStore((s) => s.setStage);
    const openSettings = useUiStore((s) => s.openSettings);
    const setShortcutsOpen = useUiStore((s) => s.setShortcutsOpen);
    const setCommandOpen = useUiStore((s) => s.setCommandOpen);
    const booth = useShellPrefs((s) => s.booth);

    return (
        <header
            className="mixai-titlebar tb"
            data-tauri-drag-region
            data-os={os}
            // macOS traffic lights sit over the left edge.
            style={os === "macos" ? { paddingLeft: 78 } : undefined}
        >
            <strong data-tauri-drag-region className="tb-brand">
                {t("shell.appName")}
            </strong>
            {!native && (
                <span data-tauri-drag-region className="tb-chip">
                    {t("app.uiPreview")}
                </span>
            )}
            <PerfHud />

            <div data-tauri-drag-region className="tb-drag" />

            {native && <RecordButton />}

            <LayoutMenu />

            <Tooltip>
                <TooltipTrigger
                    render={
                        <button
                            type="button"
                            className="dk-btn tb-btn"
                            aria-pressed={stage}
                            onClick={() => setStage(!stage)}
                            aria-label={stage ? t("shell.stageOff") : t("shell.stageOn")}
                        >
                            <Theater aria-hidden />
                            <span className="tb-text">{t("shell.stage")}</span>
                        </button>
                    }
                />
                <TooltipContent>
                    {stage ? t("shell.stageOff") : t("shell.stageOn")} <KbdCombo combo="mod+shift+s" />
                </TooltipContent>
            </Tooltip>

            <Tooltip>
                <TooltipTrigger
                    render={
                        <button
                            type="button"
                            className="dk-btn tb-btn"
                            aria-pressed={booth}
                            onClick={() => useShellPrefs.getState().set({ booth: !booth })}
                            aria-label={booth ? t("shell.boothOff") : t("shell.boothOn")}
                        >
                            <ZoomIn aria-hidden />
                            <span className="tb-text">{t("shell.booth")}</span>
                        </button>
                    }
                />
                <TooltipContent>{booth ? t("shell.boothOff") : t("shell.boothOn")}</TooltipContent>
            </Tooltip>

            <ProfileSwitcher className="tb-profile max-[1100px]:hidden" />

            <span className="tb-rule" aria-hidden />

            <Tooltip>
                <TooltipTrigger
                    render={
                        <button type="button" className="dk-btn dk-btn-icon tb-btn" onClick={() => setCommandOpen(true)} aria-label={t("topbar.commands")}>
                            <Command aria-hidden />
                        </button>
                    }
                />
                <TooltipContent>
                    {t("topbar.commands")} <KbdCombo combo="mod+k" />
                </TooltipContent>
            </Tooltip>
            <Tooltip>
                <TooltipTrigger
                    render={
                        <button type="button" className="dk-btn dk-btn-icon tb-btn" onClick={() => setShortcutsOpen(true)} aria-label={t("topbar.keys")}>
                            <Keyboard aria-hidden />
                        </button>
                    }
                />
                <TooltipContent>{t("topbar.keysHint")}</TooltipContent>
            </Tooltip>
            <Tooltip>
                <TooltipTrigger
                    render={
                        <button type="button" className="dk-btn dk-btn-icon tb-btn" data-settings-button="" onClick={() => openSettings()} aria-label={t("topbar.settings")}>
                            <Settings aria-hidden />
                        </button>
                    }
                />
                <TooltipContent>
                    {t("topbar.settings")} <KbdCombo combo="mod+," />
                </TooltipContent>
            </Tooltip>

            {(os === "windows" || os === "linux") && <WindowButtons />}
            {os === "macos" && <FullscreenButton />}
        </header>
    );
}

function LayoutMenu() {
    const t = useT();
    const activeId = useLayoutStore((s) => s.activeId);
    const setActive = useLayoutStore((s) => s.setActive);
    const layouts = useAllLayouts();
    const active = layouts.find((l) => l.id === activeId);
    const activeName = active ? layoutName(t, active) : null;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <button type="button" className="dk-btn tb-btn" aria-label={activeName ? `${t("shell.layoutPick")}. ${t("shell.layoutCurrent", { name: activeName })}` : t("shell.layoutPick")}>
                        <LayoutGrid aria-hidden />
                        <span className="tb-text tb-text-clip">{activeName ?? t("shell.layout")}</span>
                    </button>
                }
            />
            <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuLabel>{t("shell.layoutPick")}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={activeId} onValueChange={(v) => setActive(String(v))}>
                    {layouts.map((l, i) => (
                        <DropdownMenuRadioItem key={l.id} value={l.id}>
                            <span className="flex-1">{layoutName(t, l)}</span>
                            {i < 8 && <KbdCombo combo={`alt+${i + 1}`} className="ms-3 opacity-70" />}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => openLayoutEditor()}>{t("shell.editLayout")}</DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function useMaximized(): boolean {
    const [max, setMax] = useState(false);
    useEffect(() => {
        let cancelled = false;
        let off: (() => void) | undefined;
        const read = () => void windowCtl.isMaximized().then((m) => !cancelled && setMax(m));
        read();
        void windowCtl.onResized(read).then((u) => {
            if (cancelled) u();
            else off = u;
        });
        return () => {
            cancelled = true;
            off?.();
        };
    }, []);
    return max;
}

function WindowButtons() {
    const t = useT();
    const max = useMaximized();
    const snapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    return (
        <div className="mixai-winbtns" role="group" aria-label={t("shell.windowControls")}>
            <button type="button" className="mixai-winbtn" onClick={() => void windowCtl.minimize()} aria-label={t("shell.minimize")} title={t("shell.minimize")}>
                <Minus aria-hidden />
            </button>
            <button
                type="button"
                className="mixai-winbtn"
                onClick={() => void windowCtl.toggleMaximize()}
                aria-label={max ? t("shell.restore") : t("shell.maximize")}
                title={max ? t("shell.restore") : t("shell.maximize")}
                // Windows 11 Snap Layouts: open the flyout after a short hover, like native buttons.
                onPointerEnter={() => {
                    if (os !== "windows") return;
                    snapTimer.current = setTimeout(() => void windowCtl.showSnapOverlay(), 450);
                }}
                onPointerLeave={() => {
                    if (snapTimer.current) clearTimeout(snapTimer.current);
                }}
            >
                {max ? <Minimize2 aria-hidden /> : <Square aria-hidden />}
            </button>
            <button type="button" className="mixai-winbtn" data-close onClick={() => void windowCtl.close()} aria-label={t("shell.close")} title={t("shell.close")}>
                <X aria-hidden />
            </button>
        </div>
    );
}

function FullscreenButton() {
    const t = useT();
    const [fs, setFs] = useState(false);
    return (
        <button
            type="button"
            className="dk-btn dk-btn-icon tb-btn"
            aria-pressed={fs}
            aria-label={fs ? t("shell.exitFullscreen") : t("shell.fullscreen")}
            onClick={async () => {
                await windowCtl.setFullscreen(!fs);
                setFs(await windowCtl.isFullscreen());
            }}
        >
            {fs ? <Shrink aria-hidden /> : <Expand aria-hidden />}
        </button>
    );
}

function RecordButton() {
    const t = useT();
    const recording = useRecordingStore((s) => s.recording);
    const busy = useRecordingStore((s) => s.busy);
    const startedAt = useRecordingStore((s) => s.startedAt);
    const toggle = useRecordingStore((s) => s.toggle);
    const [elapsed, setElapsed] = useState(0);

    useEffect(() => {
        if (!recording) return;
        const id = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 250);
        return () => {
            clearInterval(id);
            setElapsed(0);
        };
    }, [recording, startedAt]);

    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <button
                        type="button"
                        className="dk-btn tb-btn tb-rec"
                        onClick={() => void toggle()}
                        disabled={busy}
                        aria-pressed={recording}
                    >
                        <Circle aria-hidden className="tb-rec-dot" />
                        {recording ? <span className="dk-num">{recTime(elapsed)}</span> : <span>{t("topbar.rec")}</span>}
                    </button>
                }
            />
            <TooltipContent>{recording ? t("topbar.recStop") : t("topbar.recStart")}</TooltipContent>
        </Tooltip>
    );
}
