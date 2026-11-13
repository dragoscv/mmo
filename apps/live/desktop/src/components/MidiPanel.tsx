/**
 * MIDI settings (docs/live/midi.md): open ports + activity light, channel filter, program change,
 * bindings with unbind, and learn buttons for actions / mix faders. Lives in the Settings dialog.
 */
import { useEffect, useRef, useState } from "react";
import { Cable, Unlink } from "lucide-react";
import type { TFunction } from "i18next";
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, cn } from "@mmo/ui";
import { useT } from "../i18n";
import { midiLearn, midiSettings, midiUnbind, sourceLabel, wireChannel, type MidiAction, type MidiTarget, type MixField } from "../lib/protocol";
import { useStore } from "../store";
import { MidiLearnButton } from "./MidiLearn";
import { fxLabel, paramLabel } from "./fx-labels";

const ACTIONS: MidiAction[] = [
    "next",
    "prev",
    "tap_tempo",
    "panic",
    "toggle_bypass",
    "toggle_mute",
    "toggle_monitor_untuned",
];
const MIX_FIELDS: MixField[] = ["input_db", "main_db", "monitor_db", "monitor_dry"];
const MIX_LABEL: Record<MixField, string> = { input_db: "mix.input", main_db: "mix.main", monitor_db: "mix.monitor", monitor_dry: "mix.monitorDry" };

/** Localised label for any MIDI target. */
export function targetLabel(t: TFunction, target: MidiTarget): string {
    switch (target.kind) {
        case "param":
            return `${fxLabel(t, target.fx)} · ${paramLabel(t, target.param)}`;
        case "enable":
            return t("midi.enableTarget", { fx: fxLabel(t, target.fx) });
        case "mix":
            return t(MIX_LABEL[target.field]);
        case "action":
            return t(`midi.action.${target.action}`);
    }
}

/** Flashes for a moment whenever `last` changes (new MIDI message seen). */
function ActivityLight({ last }: { last: string | null }) {
    const t = useT();
    const [on, setOn] = useState(false);
    const first = useRef(true);
    useEffect(() => {
        if (first.current) {
            first.current = false;
            return;
        }
        if (!last) return;
        setOn(true);
        const id = window.setTimeout(() => setOn(false), 180);
        return () => window.clearTimeout(id);
    }, [last]);
    return (
        <div className="flex items-center gap-2 text-sm">
            <span
                aria-hidden
                className={cn("size-2.5 rounded-full transition-colors duration-(--dur-fast)", on ? "bg-success shadow-[0_0_8px] shadow-success" : "bg-muted-foreground/30")}
            />
            <span className="text-muted-foreground">{t("midi.last")}</span>
            <code className="font-mono text-xs tabular-nums">{last ?? t("midi.noActivity")}</code>
        </div>
    );
}

export function MidiPanel() {
    const t = useT();
    const midi = useStore((s) => s.proto.state?.midi);
    const role = useStore((s) => s.proto.hello?.role);
    const send = useStore((s) => s.send);

    if (!midi) {
        return <p className="text-sm text-muted-foreground">{t("midi.unavailable")}</p>;
    }
    const canEdit = role === "controller";
    const channel = String(wireChannel(midi.map.channel));
    const channelItems: Record<string, string> = { "0": t("midi.omni") };
    for (let c = 1; c <= 16; c++) channelItems[String(c)] = t("midi.channelN", { n: c });
    const learning = midi.learning;

    return (
        <div className="flex flex-col gap-4">
            <div aria-live="polite" className="min-h-0">
                {learning ? (
                    <div className="flex items-center gap-3 rounded-xl border border-primary/50 bg-primary/10 p-3 text-sm">
                        <span aria-hidden className="size-2.5 animate-pulse rounded-full bg-primary" />
                        <span className="flex-1">{t("midi.learning", { target: targetLabel(t, learning) })}</span>
                        <Button size="sm" variant="outline" onClick={() => send(midiLearn(null))}>
                            {t("midi.learnCancel")}
                        </Button>
                    </div>
                ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
                <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("midi.ports")}</h4>
                {midi.ports.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("midi.noPorts")}</p>
                ) : (
                    <ul className="flex flex-col gap-1">
                        {midi.ports.map((p) => (
                            <li key={p} className="flex items-center gap-2 text-sm">
                                <Cable className="size-4 text-muted-foreground" aria-hidden />
                                {p}
                            </li>
                        ))}
                    </ul>
                )}
                <ActivityLight last={midi.last} />
            </div>

            <div className="flex flex-wrap items-end gap-6">
                <div className="flex flex-col gap-1">
                    <span id="midi-ch-l" className="text-sm">
                        {t("midi.channel")}
                    </span>
                    <Select items={channelItems} value={channel} disabled={!canEdit} onValueChange={(v) => send(midiSettings({ channel: Number(v) }))}>
                        <SelectTrigger size="sm" aria-labelledby="midi-ch-l" className="w-36">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {Object.entries(channelItems).map(([v, l]) => (
                                <SelectItem key={v} value={v}>
                                    {l}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="flex items-start gap-3">
                    <Switch
                        id="midi-pc"
                        checked={midi.map.program_change}
                        disabled={!canEdit}
                        onCheckedChange={(on) => send(midiSettings({ program_change: on }))}
                    />
                    <label htmlFor="midi-pc" className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium">{t("midi.programChange")}</span>
                        <span className="text-xs text-muted-foreground">{t("midi.programChangeHint")}</span>
                    </label>
                </div>
            </div>

            <div className="flex flex-col gap-1.5">
                <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("midi.bindings")}</h4>
                {midi.map.bindings.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("midi.noBindings")}</p>
                ) : (
                    <ul className="flex flex-col divide-y rounded-xl border">
                        {midi.map.bindings.map((b, i) => {
                            const label = targetLabel(t, b.target);
                            return (
                                <li key={`${i}-${b.source.kind}-${b.source.number}-${b.source.channel ?? "x"}`} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                                    <code className="w-32 shrink-0 font-mono text-xs tabular-nums">{sourceLabel(b.source, t("midi.omni"))}</code>
                                    <span className="min-w-0 flex-1 truncate">{label}</span>
                                    {canEdit ? (
                                        <Button
                                            variant="ghost"
                                            size="icon-xs"
                                            aria-label={t("midi.unbind", { target: label })}
                                            title={t("midi.unbind", { target: label })}
                                            className="hover:text-destructive"
                                            onClick={() => send(midiUnbind(i))}
                                        >
                                            <Unlink />
                                        </Button>
                                    ) : null}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            {canEdit ? (
                <div className="flex flex-col gap-1.5">
                    <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t("midi.learnTitle")}</h4>
                    <p className="text-xs text-muted-foreground">{t("midi.learnHint")}</p>
                    <ul className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                        {ACTIONS.map((a) => {
                            const target: MidiTarget = { kind: "action", action: a };
                            const label = targetLabel(t, target);
                            return (
                                <li key={a} className="flex items-center gap-1.5 text-sm">
                                    <MidiLearnButton target={target} label={label} />
                                    {label}
                                </li>
                            );
                        })}
                        {MIX_FIELDS.map((f) => {
                            const target: MidiTarget = { kind: "mix", field: f };
                            const label = targetLabel(t, target);
                            return (
                                <li key={f} className="flex items-center gap-1.5 text-sm">
                                    <MidiLearnButton target={target} label={label} />
                                    {label}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            ) : null}
        </div>
    );
}
