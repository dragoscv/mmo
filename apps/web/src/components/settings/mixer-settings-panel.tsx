"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
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
    Slider,
    Switch,
} from "@mmo/ui";
import { useMidi } from "@/hooks/use-midi";
import { AudioDeviceSelect } from "@/components/ui/audio-device-select";

// Same keys the mixer console reads (mixer-settings-modal.tsx / mixer-waveforms.tsx).
const AUDIO_OUTPUT_KEY = "mmo-audio-output";
const ZOOM_KEY = "mmo-mixer-wf-zoom";
const BEATGRID_KEY = "mmo-mixer-beatgrid";

interface Zoom { zoomA: number; zoomB: number; linked: boolean }

function readAudioOutput(): string {
    try { return localStorage.getItem(AUDIO_OUTPUT_KEY) || "default"; } catch { return "default"; }
}

function readZoom(): Zoom {
    try {
        const raw = localStorage.getItem(ZOOM_KEY);
        if (raw) {
            const p = JSON.parse(raw);
            return {
                zoomA: Math.max(1, Math.min(64, p.zoomA ?? 4)),
                zoomB: Math.max(1, Math.min(64, p.zoomB ?? 4)),
                linked: p.linked ?? true,
            };
        }
    } catch { /* ignore */ }
    return { zoomA: 4, zoomB: 4, linked: true };
}

function writeZoom(z: Zoom) {
    try { localStorage.setItem(ZOOM_KEY, JSON.stringify(z)); } catch { /* ignore */ }
}

function readBeatgrid(): boolean {
    try {
        const raw = localStorage.getItem(BEATGRID_KEY);
        return raw !== null ? JSON.parse(raw) : true;
    } catch { return true; }
}

function writeBeatgrid(v: boolean) {
    try {
        localStorage.setItem(BEATGRID_KEY, JSON.stringify(v));
        window.dispatchEvent(new CustomEvent("beatgrid-changed"));
    } catch { /* ignore */ }
}

const TEMPO_RANGES = [6, 8, 10, 16, 25];
const CURVES = ["linear", "smooth", "sharp"] as const;

export function MixerSettingsPanel() {
    const t = useTranslations("settings.mixer");
    const midi = useMidi();
    const [output, setOutput] = useState(readAudioOutput);
    const [zoom, setZoom] = useState<Zoom>(readZoom);
    const [beatgrid, setBeatgrid] = useState<boolean>(readBeatgrid);

    const updateZoom = (patch: Partial<Zoom>) => {
        const next = { ...zoom, ...patch };
        if (next.linked && patch.zoomA != null) next.zoomB = patch.zoomA;
        if (next.linked && patch.zoomB != null) next.zoomA = patch.zoomB;
        setZoom(next);
        writeZoom(next);
    };

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle>{t("audio.title")}</CardTitle>
                    <CardDescription>{t("audio.description")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                    <Label>{t("audio.output")}</Label>
                    <AudioDeviceSelect
                        kind="output"
                        value={output === "default" ? "" : output}
                        nativeDisabled
                        nativeDisabledHint={t("audio.nativeHint")}
                        onValueChange={(c) => {
                            const id = c.value || "default";
                            setOutput(id);
                            try { localStorage.setItem(AUDIO_OUTPUT_KEY, id); } catch { /* ignore */ }
                        }}
                    />
                    <p className="text-xs text-muted-foreground">{t("audio.appliesNext")}</p>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("waveform.title")}</CardTitle>
                    <CardDescription>{t("waveform.description")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center justify-between gap-4">
                        <Label htmlFor="mixer-zoom-linked">{t("waveform.linked")}</Label>
                        <Switch id="mixer-zoom-linked" checked={zoom.linked} onCheckedChange={(v) => updateZoom({ linked: v, ...(v ? { zoomB: zoom.zoomA } : {}) })} />
                    </div>
                    <Slider label={t("waveform.zoomA")} showValue min={1} max={64} step={1} value={zoom.zoomA} onValueChange={(v) => updateZoom({ zoomA: v })} />
                    <Slider label={t("waveform.zoomB")} showValue min={1} max={64} step={1} value={zoom.zoomB} disabled={zoom.linked} onValueChange={(v) => updateZoom({ zoomB: v })} />
                    <div className="flex items-center justify-between gap-4">
                        <div>
                            <Label htmlFor="mixer-beatgrid">{t("waveform.beatgrid")}</Label>
                            <p className="mt-1 text-xs text-muted-foreground">{t("waveform.beatgridHint")}</p>
                        </div>
                        <Switch id="mixer-beatgrid" checked={beatgrid} onCheckedChange={(v) => { setBeatgrid(v); writeBeatgrid(v); }} />
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("midi.title")}</CardTitle>
                    <CardDescription>{t("midi.description")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <Slider label={t("midi.jogSensitivity")} showValue min={0.5} max={2} step={0.1} value={midi.settings.jogSensitivity} onValueChange={(v) => midi.updateSettings({ jogSensitivity: v })} />
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="mixer-tempo">{t("midi.tempoRange")}</Label>
                        <Select value={String(midi.settings.tempoRange)} onValueChange={(v) => midi.updateSettings({ tempoRange: Number(v) })}>
                            <SelectTrigger id="mixer-tempo" className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {TEMPO_RANGES.map((r) => <SelectItem key={r} value={String(r)}>±{r}%</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="mixer-curve">{t("midi.crossfaderCurve")}</Label>
                        <Select value={midi.settings.crossfaderCurve} onValueChange={(v) => midi.updateSettings({ crossfaderCurve: v as (typeof CURVES)[number] })}>
                            <SelectTrigger id="mixer-curve" className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {CURVES.map((c) => <SelectItem key={c} value={c}>{t(`midi.curves.${c}`)}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("console.title")}</CardTitle>
                    <CardDescription>{t("console.description")}</CardDescription>
                </CardHeader>
                <CardContent>
                    <Button variant="outline" render={<Link href="/mixer" />}>
                        <ExternalLinkIcon aria-hidden />
                        {t("console.open")}
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
}
