/** Mix strip: input/main/monitor gains, monitor dry, tuned-for-the-audience, BYPASS, MUTE, PANIC. */
import { Ear, OctagonAlert, VolumeX, Waves } from "lucide-react";
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
    cn,
} from "@mmo/ui";
import { useT } from "../i18n";
import type { ParamSpec } from "../lib/params";
import { useMeterSample } from "../lib/meter-bus";
import { useStore } from "../store";
import { Knob } from "./Knob";
import { MidiLearnButton } from "./MidiLearn";
import { valueLabel } from "./fx-labels";

const GAIN: ParamSpec = { id: "gain", min: -60, max: 12, default: 0, unit: "db", curve: "linear", choices: [] };
const DRY: ParamSpec = { id: "dry", min: 0, max: 1, default: 0, unit: "percent", curve: "linear", choices: [] };

export function MixStrip() {
    const t = useT();
    const mix = useStore((s) => s.proto.state?.mix);
    const send = useStore((s) => s.send);
    const sendCoalesced = useStore((s) => s.sendCoalesced);
    const m = useMeterSample(4);
    const monLat = m?.monitor_chain_latency_samples;
    const untunedLatency = m?.chain_latency_samples;
    const disabled = !mix;
    const s = mix ?? {
        input_db: 0,
        main_db: 0,
        monitor_db: 0,
        monitor_dry: 0,
        monitor_untuned: false,
        bypass: false,
        mute: false,
    };
    const knob = (key: "input_db" | "main_db" | "monitor_db" | "monitor_dry", label: string, spec: ParamSpec) => (
        <div className="relative">
            <Knob
                spec={spec}
                value={s[key]}
                label={label}
                valueText={valueLabel(t, spec, s[key])}
                size={48}
                disabled={disabled}
                onChange={(v) => sendCoalesced(`mix:${key}`, { type: "set_mix", [key]: v })}
            />
            <MidiLearnButton target={{ kind: "mix", field: key }} label={label} className="absolute -top-1 right-0 size-5" />
        </div>
    );

    return (
        <section aria-label={t("mix.title")} className="surface flex items-center gap-1 rounded-2xl px-3 py-2">
            {knob("input_db", t("mix.input"), GAIN)}
            {knob("main_db", t("mix.main"), GAIN)}
            {knob("monitor_db", t("mix.monitor"), GAIN)}
            {knob("monitor_dry", t("mix.monitorDry"), DRY)}
            <div className="ms-2 flex flex-col gap-1.5">
                <Button
                    size="sm"
                    variant={s.monitor_untuned ? "default" : "outline"}
                    aria-pressed={s.monitor_untuned}
                    disabled={disabled}
                    title={t("mix.monitorUntunedHint")}
                    onClick={() => send({ type: "set_mix", monitor_untuned: !s.monitor_untuned })}
                    className={cn("w-28 justify-start", s.monitor_untuned && "bg-accent text-accent-foreground hover:bg-accent/90")}
                >
                    <Ear /> {t("mix.monitorUntuned")}
                </Button>
                {monLat != null && untunedLatency != null ? (
                    <span className="w-28 text-[11px] leading-tight text-muted-foreground">
                        {t("mix.chainLatency", { ears: monLat, main: untunedLatency })}
                    </span>
                ) : null}
                <div className="flex items-center gap-0.5">
                    <Button
                        size="sm"
                        variant={s.bypass ? "default" : "outline"}
                        aria-pressed={s.bypass}
                        disabled={disabled}
                        onClick={() => send({ type: "set_mix", bypass: !s.bypass })}
                        className={cn("w-28 justify-start", s.bypass && "bg-warning text-primary-foreground hover:bg-warning/90")}
                    >
                        <Waves /> {t("mix.bypass")}
                    </Button>
                    <MidiLearnButton target={{ kind: "action", action: "toggle_bypass" }} label={t("mix.bypass")} />
                </div>
                <div className="flex items-center gap-0.5">
                    <Button
                        size="sm"
                        variant={s.mute ? "default" : "outline"}
                        aria-pressed={s.mute}
                        disabled={disabled}
                        onClick={() => send({ type: "set_mix", mute: !s.mute })}
                        className={cn("w-28 justify-start", s.mute && "bg-destructive text-destructive-foreground hover:bg-destructive/90")}
                    >
                        <VolumeX /> {t("mix.mute")}
                    </Button>
                    <MidiLearnButton target={{ kind: "action", action: "toggle_mute" }} label={t("mix.mute")} />
                </div>
            </div>
            <AlertDialog>
                <AlertDialogTrigger
                    render={
                        <Button variant="destructive" disabled={disabled} className="ms-1 h-auto self-stretch px-3">
                            <OctagonAlert className="size-5" /> {t("mix.panic")}
                        </Button>
                    }
                />
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{t("mix.panicTitle")}</AlertDialogTitle>
                        <AlertDialogDescription>{t("mix.panicBody")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{t("mix.cancel")}</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => send({ type: "panic" })}>
                            {t("mix.panicConfirm")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
            <MidiLearnButton target={{ kind: "action", action: "panic" }} label={t("mix.panic")} className="self-start" />
        </section>
    );
}
