"use client";

import { useTranslations } from "next-intl";
import {
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
    Switch,
} from "@mmo/ui";
import { toast } from "sonner";
import {
    DEFAULT_EDITOR_STATUS_BAR_STATS,
    EDITOR_WAVEFORM_COLORS,
    useDAWSettings,
    type EditorWaveformColor,
    type SpectrogramColorMap,
    type StatusBarStatsConfig,
} from "@/hooks/use-daw-settings";

const WAVEFORM_COLORS = Object.keys(EDITOR_WAVEFORM_COLORS) as EditorWaveformColor[];
const COLOR_MAPS: SpectrogramColorMap[] = ["magma", "viridis", "inferno", "plasma", "grayscale"];
const FFT_SIZES = [512, 1024, 2048, 4096];
const STATS_KEYS = Object.keys(DEFAULT_EDITOR_STATUS_BAR_STATS) as Array<keyof StatusBarStatsConfig>;

function SwitchRow({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <div className="flex items-center justify-between gap-4">
            <Label htmlFor={id}>{label}</Label>
            <Switch id={id} checked={checked} onCheckedChange={onChange} />
        </div>
    );
}

export function SoundEditorSettingsPanel() {
    const t = useTranslations("settings.sound-editor");
    const s = useDAWSettings();

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle>{t("waveform.title")}</CardTitle>
                    <CardDescription>{t("waveform.description")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="se-wf-color">{t("waveform.color")}</Label>
                        <Select value={s.editorWaveformColor} onValueChange={(v) => s.update({ editorWaveformColor: v as EditorWaveformColor })}>
                            <SelectTrigger id="se-wf-color" className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {WAVEFORM_COLORS.map((c) => (
                                    <SelectItem key={c} value={c}>
                                        <span className="inline-flex items-center gap-2">
                                            <span aria-hidden className="size-3 rounded-full border border-border" style={{ background: EDITOR_WAVEFORM_COLORS[c] }} />
                                            {t(`waveform.colors.${c}`)}
                                        </span>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <SwitchRow id="se-rms" label={t("waveform.showRms")} checked={s.editorShowRms} onChange={(v) => s.update({ editorShowRms: v })} />
                    <SwitchRow id="se-grid" label={t("waveform.showGrid")} checked={s.editorShowGridLines} onChange={(v) => s.update({ editorShowGridLines: v })} />
                    <SwitchRow id="se-minimap" label={t("waveform.showMinimap")} checked={s.editorShowMinimap} onChange={(v) => s.update({ editorShowMinimap: v })} />
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("spectrogram.title")}</CardTitle>
                    <CardDescription>{t("spectrogram.description")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="se-cmap">{t("spectrogram.colorMap")}</Label>
                        <Select value={s.spectrogramColorMap} onValueChange={(v) => s.update({ spectrogramColorMap: v as SpectrogramColorMap })}>
                            <SelectTrigger id="se-cmap" className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {COLOR_MAPS.map((c) => <SelectItem key={c} value={c}>{t(`spectrogram.maps.${c}`)}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="se-fft">{t("spectrogram.fftSize")}</Label>
                        <Select value={String(s.spectrogramFftSize)} onValueChange={(v) => s.update({ spectrogramFftSize: Number(v) })}>
                            <SelectTrigger id="se-fft" className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {FFT_SIZES.map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                            </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">{t("spectrogram.fftHint")}</p>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("stats.title")}</CardTitle>
                    <CardDescription>{t("stats.description")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {STATS_KEYS.map((k) => (
                        <SwitchRow key={k} id={`se-stat-${k}`} label={t(`stats.keys.${k}`)} checked={s.editorStatusBarStats[k]} onChange={(v) => s.update({ editorStatusBarStats: { ...s.editorStatusBarStats, [k]: v } })} />
                    ))}
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { s.update({ editorStatusBarStats: { ...DEFAULT_EDITOR_STATUS_BAR_STATS } }); toast.success(t("stats.resetDone")); }}
                    >
                        {t("stats.reset")}
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
}
