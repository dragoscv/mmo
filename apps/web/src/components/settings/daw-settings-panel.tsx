"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Slider,
    Switch,
} from "@mmo/ui";
import { toast } from "sonner";
import {
    useDAWSettings,
    type ClipDisplayMode,
    type GridStyle,
    type PlayheadColor,
    type StatusBarStatsConfig,
    type TrackHeight,
    type WaveformColorMode,
    type WaveformStyle,
} from "@/hooks/use-daw-settings";
import { useMidi } from "@/hooks/use-midi";
import { NOTATION_LABELS, type NoteNotation } from "@/lib/note-notation";
import { listDriverInfos } from "@/lib/controllers/drivers/registry";
import { AudioDeviceSelect } from "@/components/ui/audio-device-select";

const CLIP_MODES: ClipDisplayMode[] = ["waveform", "notes", "both", "none"];
const WAVEFORM_STYLES: WaveformStyle[] = ["classic", "bars", "lines", "filled"];
const WAVEFORM_COLORS: WaveformColorMode[] = ["clip", "mono", "gradient"];
const TRACK_HEIGHTS: TrackHeight[] = ["compact", "normal", "large"];
const GRID_STYLES: GridStyle[] = ["lines", "dots", "none"];
const PLAYHEAD_COLORS: PlayheadColor[] = ["green", "red", "white", "cyan", "orange"];
const NOTATIONS: NoteNotation[] = ["anglo", "solfege", "camelot"];
const STATS_KEYS = Object.keys({
    showFps: 0, showHeapMemory: 0, showJsHeapTotal: 0, showDomNodes: 0, showAudioLatency: 0, showCpuCores: 0, showDeviceMemory: 0,
} satisfies Record<keyof StatusBarStatsConfig, 0>) as Array<keyof StatusBarStatsConfig>;
const TEMPO_RANGES = [6, 8, 10, 16, 25];
const CROSSFADER_CURVES = ["linear", "smooth", "sharp"] as const;

const LAYOUT_KEYS = ["daw_ui_state", "daw_dockview_layout"];

function SwitchRow({ id, label, hint, checked, onChange }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
                <Label htmlFor={id}>{label}</Label>
                {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
            </div>
            <Switch id={id} checked={checked} onCheckedChange={onChange} />
        </div>
    );
}

function SelectRow<V extends string>({ id, label, value, options, labelFor, onChange }: {
    id: string; label: string; value: V; options: readonly V[]; labelFor: (v: V) => string; onChange: (v: V) => void;
}) {
    return (
        <div className="flex flex-col gap-2">
            <Label htmlFor={id}>{label}</Label>
            <Select value={value} onValueChange={(v) => onChange(v as V)}>
                <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                    {options.map((o) => <SelectItem key={o} value={o}>{labelFor(o)}</SelectItem>)}
                </SelectContent>
            </Select>
        </div>
    );
}

export function DawSettingsPanel() {
    const t = useTranslations("settings.daw");
    const s = useDAWSettings();
    const midi = useMidi();
    const [layoutOpen, setLayoutOpen] = useState(false);
    const drivers = listDriverInfos().filter((d) => d.id !== "generic-midi");

    const resetLayout = () => {
        try {
            for (const k of LAYOUT_KEYS) localStorage.removeItem(k);
            toast.success(t("layout.resetDone"));
        } catch {
            toast.error(t("layout.resetFailed"));
        }
    };

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle>{t("audio.title")}</CardTitle>
                    <CardDescription>{t("audio.description")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex flex-col gap-2">
                        <Label>{t("audio.output")}</Label>
                        <AudioDeviceSelect kind="output" value={s.audioOutputDeviceId === "default" ? "" : s.audioOutputDeviceId} onValueChange={(c) => s.update({ audioOutputDeviceId: c.value || "default" })} />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label>{t("audio.input")}</Label>
                        <AudioDeviceSelect kind="input" value={s.audioInputDeviceId === "default" ? "" : s.audioInputDeviceId} onValueChange={(c) => s.update({ audioInputDeviceId: c.value || "default" })} />
                    </div>
                    <SwitchRow id="daw-monitor" label={t("audio.monitor")} hint={t("audio.monitorHint")} checked={s.inputMonitorEnabled} onChange={(v) => s.update({ inputMonitorEnabled: v })} />
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("clips.title")}</CardTitle>
                    <CardDescription>{t("clips.description")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <SelectRow id="daw-clip-mode" label={t("clips.displayMode")} value={s.clipDisplayMode} options={CLIP_MODES} labelFor={(v) => t(`clips.modes.${v}`)} onChange={(v) => s.update({ clipDisplayMode: v })} />
                    <SelectRow id="daw-wf-style" label={t("clips.waveformStyle")} value={s.waveformStyle} options={WAVEFORM_STYLES} labelFor={(v) => t(`clips.styles.${v}`)} onChange={(v) => s.update({ waveformStyle: v })} />
                    <SelectRow id="daw-wf-color" label={t("clips.waveformColor")} value={s.waveformColorMode} options={WAVEFORM_COLORS} labelFor={(v) => t(`clips.colors.${v}`)} onChange={(v) => s.update({ waveformColorMode: v })} />
                    <SwitchRow id="daw-clip-names" label={t("clips.showNames")} checked={s.showClipNames} onChange={(v) => s.update({ showClipNames: v })} />
                    <SwitchRow id="daw-clip-badges" label={t("clips.showBadges")} checked={s.showClipInfoBadges} onChange={(v) => s.update({ showClipInfoBadges: v })} />
                    <Slider label={t("clips.opacity")} showValue min={0.3} max={1} step={0.05} value={s.clipOpacity} onValueChange={(v) => s.update({ clipOpacity: v })} />
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("timeline.title")}</CardTitle>
                    <CardDescription>{t("timeline.description")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <SelectRow id="daw-track-height" label={t("timeline.trackHeight")} value={s.trackHeight} options={TRACK_HEIGHTS} labelFor={(v) => t(`timeline.heights.${v}`)} onChange={(v) => s.update({ trackHeight: v })} />
                    <SelectRow id="daw-grid" label={t("timeline.gridStyle")} value={s.gridStyle} options={GRID_STYLES} labelFor={(v) => t(`timeline.grids.${v}`)} onChange={(v) => s.update({ gridStyle: v })} />
                    <Slider label={t("timeline.gridOpacity")} showValue min={0} max={1} step={0.05} value={s.gridOpacity} onValueChange={(v) => s.update({ gridOpacity: v })} />
                    <SelectRow id="daw-playhead" label={t("timeline.playheadColor")} value={s.playheadColor} options={PLAYHEAD_COLORS} labelFor={(v) => t(`timeline.playheads.${v}`)} onChange={(v) => s.update({ playheadColor: v })} />
                    <SwitchRow id="daw-snap" label={t("timeline.snapToGrid")} checked={s.snapToGrid} onChange={(v) => s.update({ snapToGrid: v })} />
                    <SwitchRow id="daw-automation" label={t("timeline.showAutomation")} checked={s.showAutomation} onChange={(v) => s.update({ showAutomation: v })} />
                    <SwitchRow id="daw-active-clip" label={t("timeline.activeClipHighlight")} checked={s.activeClipHighlight} onChange={(v) => s.update({ activeClipHighlight: v })} />
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("notation.title")}</CardTitle>
                    <CardDescription>{t("notation.description")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <SelectRow id="daw-notation-1" label={t("notation.primary")} value={s.noteNotation1} options={NOTATIONS} labelFor={(v) => NOTATION_LABELS[v]} onChange={(v) => s.update({ noteNotation1: v })} />
                    <SelectRow<NoteNotation | "none"> id="daw-notation-2" label={t("notation.secondary")} value={s.noteNotation2} options={["none", ...NOTATIONS]} labelFor={(v) => (v === "none" ? t("notation.none") : NOTATION_LABELS[v])} onChange={(v) => s.update({ noteNotation2: v })} />
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("stats.title")}</CardTitle>
                    <CardDescription>{t("stats.description")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {STATS_KEYS.map((k) => (
                        <SwitchRow key={k} id={`daw-stat-${k}`} label={t(`stats.keys.${k}`)} checked={s.dawStatusBarStats[k]} onChange={(v) => s.update({ dawStatusBarStats: { ...s.dawStatusBarStats, [k]: v } })} />
                    ))}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("midi.title")}</CardTitle>
                    <CardDescription>{t("midi.description")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <SwitchRow id="daw-midi-enabled" label={t("midi.enabled")} checked={midi.settings.enabled} onChange={(v) => midi.updateSettings({ enabled: v })} />
                    <Slider label={t("midi.jogSensitivity")} showValue min={0.5} max={2} step={0.1} value={midi.settings.jogSensitivity} onValueChange={(v) => midi.updateSettings({ jogSensitivity: v })} />
                    <SelectRow id="daw-midi-tempo" label={t("midi.tempoRange")} value={String(midi.settings.tempoRange)} options={TEMPO_RANGES.map(String)} labelFor={(v) => `±${v}%`} onChange={(v) => midi.updateSettings({ tempoRange: Number(v) })} />
                    <SelectRow id="daw-midi-curve" label={t("midi.crossfaderCurve")} value={midi.settings.crossfaderCurve} options={CROSSFADER_CURVES} labelFor={(v) => t(`midi.curves.${v}`)} onChange={(v) => midi.updateSettings({ crossfaderCurve: v })} />
                    <SelectRow id="daw-midi-driver" label={t("midi.driver")} value={midi.settings.controllerDriverId ?? "auto"} options={["auto", ...drivers.map((d) => d.id)]} labelFor={(v) => (v === "auto" ? t("midi.autoDetect") : drivers.find((d) => d.id === v)?.name ?? v)} onChange={(v) => midi.updateSettings({ controllerDriverId: v === "auto" ? null : v })} />
                    <p className="text-xs text-muted-foreground">{t("midi.devices", { count: midi.devices.length, status: midi.status })}</p>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("layout.title")}</CardTitle>
                    <CardDescription>{t("layout.description")}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                    <AlertDialog open={layoutOpen} onOpenChange={setLayoutOpen}>
                        <AlertDialogTrigger render={<Button variant="outline" />}>{t("layout.reset")}</AlertDialogTrigger>
                        <AlertDialogContent size="sm">
                            <AlertDialogHeader>
                                <AlertDialogTitle>{t("layout.confirmTitle")}</AlertDialogTitle>
                                <AlertDialogDescription>{t("layout.confirmBody")}</AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                                <AlertDialogCancel>{t("layout.cancel")}</AlertDialogCancel>
                                <AlertDialogAction variant="destructive" onClick={resetLayout}>{t("layout.reset")}</AlertDialogAction>
                            </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>
                    <Button variant="ghost" onClick={() => { s.reset(); toast.success(t("layout.defaultsDone")); }}>{t("layout.defaults")}</Button>
                </CardContent>
            </Card>
        </div>
    );
}
