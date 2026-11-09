/** Mix strip: input/main/monitor gains, monitor dry, BYPASS, MUTE, PANIC (with confirmation). */
import { OctagonAlert, VolumeX, Waves } from "lucide-react";
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
import { useStore } from "../store";
import { Knob } from "./Knob";
import { valueLabel } from "./fx-labels";

const GAIN: ParamSpec = { id: "gain", min: -60, max: 12, default: 0, unit: "db", curve: "linear", choices: [] };
const DRY: ParamSpec = { id: "dry", min: 0, max: 1, default: 0, unit: "percent", curve: "linear", choices: [] };

export function MixStrip() {
    const t = useT();
    const mix = useStore((s) => s.proto.state?.mix);
    const send = useStore((s) => s.send);
    const sendCoalesced = useStore((s) => s.sendCoalesced);
    const disabled = !mix;
    const m = mix ?? { input_db: 0, main_db: 0, monitor_db: 0, monitor_dry: 0, bypass: false, mute: false };
    const knob = (key: "input_db" | "main_db" | "monitor_db" | "monitor_dry", label: string, spec: ParamSpec) => (
        <Knob
            spec={spec}
            value={m[key]}
            label={label}
            valueText={valueLabel(t, spec, m[key])}
            size={48}
            disabled={disabled}
            onChange={(v) => sendCoalesced(`mix:${key}`, { type: "set_mix", [key]: v })}
        />
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
                    variant={m.bypass ? "default" : "outline"}
                    aria-pressed={m.bypass}
                    disabled={disabled}
                    onClick={() => send({ type: "set_mix", bypass: !m.bypass })}
                    className={cn("w-28 justify-start", m.bypass && "bg-warning text-primary-foreground hover:bg-warning/90")}
                >
                    <Waves /> {t("mix.bypass")}
                </Button>
                <Button
                    size="sm"
                    variant={m.mute ? "default" : "outline"}
                    aria-pressed={m.mute}
                    disabled={disabled}
                    onClick={() => send({ type: "set_mix", mute: !m.mute })}
                    className={cn("w-28 justify-start", m.mute && "bg-destructive text-destructive-foreground hover:bg-destructive/90")}
                >
                    <VolumeX /> {t("mix.mute")}
                </Button>
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
        </section>
    );
}
