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
    ToggleGroup,
    ToggleGroupItem,
} from "@mmo/ui";
import { toast } from "sonner";
import { useLiveSettings, type CoachVerbosity, type LiveAccent } from "@/hooks/use-live-settings";
import { NOTATION_LABELS, type NoteNotation } from "@/lib/note-notation";
import { AudioDeviceSelect } from "@/components/ui/audio-device-select";

const NOTATIONS: NoteNotation[] = ["anglo", "solfege", "camelot"];
const VERBOSITY: CoachVerbosity[] = ["minimal", "normal", "verbose"];
const ACCENTS: LiveAccent[] = ["rose", "violet", "emerald", "cyan", "amber"];
const ACCENT_SWATCH: Record<LiveAccent, string> = {
    rose: "bg-rose-500",
    violet: "bg-violet-500",
    emerald: "bg-emerald-500",
    cyan: "bg-cyan-500",
    amber: "bg-amber-500",
};
const LAYOUT_KEY = "live-widget-grid-v1";

export function LiveSettingsPanel() {
    const t = useTranslations("settings.live");
    const s = useLiveSettings();
    const [open, setOpen] = useState(false);

    const resetLayout = () => {
        try {
            localStorage.removeItem(LAYOUT_KEY);
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
                <CardContent className="space-y-2">
                    <Label>{t("audio.output")}</Label>
                    <AudioDeviceSelect
                        kind="output"
                        value={s.audioOutputDeviceId === "default" ? "" : s.audioOutputDeviceId}
                        onValueChange={(c) => s.update({ audioOutputDeviceId: c.value || "default" })}
                    />
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("notation.title")}</CardTitle>
                    <CardDescription>{t("notation.description")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="live-notation-1">{t("notation.primary")}</Label>
                        <Select value={s.noteNotation1} onValueChange={(v) => s.update({ noteNotation1: v as NoteNotation })}>
                            <SelectTrigger id="live-notation-1" className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {NOTATIONS.map((n) => <SelectItem key={n} value={n}>{NOTATION_LABELS[n]}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="live-notation-2">{t("notation.secondary")}</Label>
                        <Select value={s.noteNotation2} onValueChange={(v) => s.update({ noteNotation2: v as NoteNotation | "none" })}>
                            <SelectTrigger id="live-notation-2" className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="none">{t("notation.none")}</SelectItem>
                                {NOTATIONS.map((n) => <SelectItem key={n} value={n}>{NOTATION_LABELS[n]}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                        <Label htmlFor="live-cents">{t("notation.showCents")}</Label>
                        <Switch id="live-cents" checked={s.showCents} onCheckedChange={(v) => s.update({ showCents: v })} />
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("display.title")}</CardTitle>
                    <CardDescription>{t("display.description")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <Slider label={t("display.refreshHz")} showValue min={1} max={30} step={1} value={s.refreshHz} onValueChange={(v) => s.update({ refreshHz: v })} />
                    <Slider label={t("display.tunerStickiness")} showValue min={0} max={3000} step={50} value={s.tunerStickinessMs} onValueChange={(v) => s.update({ tunerStickinessMs: v })} />
                    <Slider label={t("display.coachStickiness")} showValue min={0} max={5000} step={100} value={s.coachStickinessMs} onValueChange={(v) => s.update({ coachStickinessMs: v })} />
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="live-verbosity">{t("display.coachVerbosity")}</Label>
                        <Select value={s.coachVerbosity} onValueChange={(v) => s.update({ coachVerbosity: v as CoachVerbosity })}>
                            <SelectTrigger id="live-verbosity" className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {VERBOSITY.map((v) => <SelectItem key={v} value={v}>{t(`display.verbosity.${v}`)}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("accent.title")}</CardTitle>
                    <CardDescription>{t("accent.description")}</CardDescription>
                </CardHeader>
                <CardContent>
                    <ToggleGroup variant="outline" value={[s.accent]} onValueChange={(v) => { const next = v[0]; if (next) s.update({ accent: next as LiveAccent }); }} aria-label={t("accent.title")}>
                        {ACCENTS.map((a) => (
                            <ToggleGroupItem key={a} value={a} aria-label={t(`accent.names.${a}`)}>
                                <span aria-hidden className={`size-3 rounded-full ${ACCENT_SWATCH[a]}`} />
                                <span className="hidden sm:inline">{t(`accent.names.${a}`)}</span>
                            </ToggleGroupItem>
                        ))}
                    </ToggleGroup>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("layout.title")}</CardTitle>
                    <CardDescription>{t("layout.description")}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                    <AlertDialog open={open} onOpenChange={setOpen}>
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
