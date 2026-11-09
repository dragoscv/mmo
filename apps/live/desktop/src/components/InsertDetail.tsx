/** Detail panel for the selected insert: every parameter as knob / select / switch, generated from specs. */
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from "@mmo/ui";
import { useT } from "../i18n";
import { controlKind, type ParamSpec } from "../lib/params";
import type { InsertState } from "../lib/protocol";
import { EMPTY_CHAIN, useStore } from "../store";
import { Knob } from "./Knob";
import { GrBar } from "./Meters";
import { choiceLabel, fxLabel, paramLabel, valueLabel } from "./fx-labels";

function ParamControl({ insert, spec, value }: { insert: InsertState; spec: ParamSpec; value: number }) {
    const t = useT();
    const send = useStore((s) => s.send);
    const sendCoalesced = useStore((s) => s.sendCoalesced);
    const label = paramLabel(t, spec.id);
    const set = (v: number) => sendCoalesced(`p:${insert.id}:${spec.id}`, { type: "set_param", insert: insert.id, param: spec.id, value: v });
    const kind = controlKind(spec);
    const id = `p-${insert.id}-${spec.id}`;

    if (kind === "toggle") {
        return (
            <div className="flex w-28 flex-col items-center justify-center gap-2">
                <Switch
                    id={id}
                    checked={value >= 0.5}
                    onCheckedChange={(on) => send({ type: "set_param", insert: insert.id, param: spec.id, value: on ? 1 : 0 })}
                />
                <label htmlFor={id} className="text-center text-[11px] text-muted-foreground">
                    {label}
                </label>
            </div>
        );
    }
    if (kind === "choice") {
        const items = Object.fromEntries(spec.choices.map((c, i) => [String(i), choiceLabel(t, spec, c)]));
        return (
            <div className="flex w-36 flex-col gap-1">
                <span id={`${id}-l`} className="text-[11px] text-muted-foreground">
                    {label}
                </span>
                <Select
                    items={items}
                    value={String(Math.round(value))}
                    onValueChange={(v) => send({ type: "set_param", insert: insert.id, param: spec.id, value: Number(v) })}
                >
                    <SelectTrigger size="sm" aria-labelledby={`${id}-l`} className="w-full">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {spec.choices.map((c, i) => (
                            <SelectItem key={c} value={String(i)}>
                                {choiceLabel(t, spec, c)}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
        );
    }
    return <Knob spec={spec} value={value} label={label} valueText={valueLabel(t, spec, value)} onChange={set} />;
}

export function InsertDetail() {
    const t = useT();
    const selected = useStore((s) => s.selectedInsert);
    const chain = useStore((s) => s.proto.state?.chain ?? EMPTY_CHAIN);
    const catalogue = useStore((s) => s.catalogue);
    const select = useStore((s) => s.selectInsert);
    const index = chain.findIndex((c) => c.id === selected);
    const insert = index >= 0 ? chain[index] : undefined;
    const specs = insert ? (catalogue.find((f) => f.id === insert.fx)?.params ?? []) : [];

    return (
        <AnimatePresence mode="popLayout" initial={false}>
            {insert ? (
                <motion.section
                    key={insert.id}
                    layout
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 16 }}
                    transition={{ type: "spring", stiffness: 380, damping: 34 }}
                    aria-label={fxLabel(t, insert.fx)}
                    className="surface flex min-h-0 flex-col gap-3 rounded-2xl p-4"
                >
                    <header className="flex items-center gap-3">
                        <h2 className="font-heading text-lg font-semibold">{fxLabel(t, insert.fx)}</h2>
                        <div className="w-40">
                            <GrBar index={index} label={t("chain.gr")} />
                        </div>
                        <span className="ms-auto text-xs text-muted-foreground">{t("chain.resetHint")}</span>
                        <Button variant="ghost" size="icon-sm" aria-label={t("chain.close")} onClick={() => select(null)}>
                            <X />
                        </Button>
                    </header>
                    {specs.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("chain.noParams")}</p>
                    ) : (
                        <div className="flex min-h-0 flex-wrap content-start items-start gap-x-3 gap-y-4 overflow-y-auto">
                            {specs.map((spec) => {
                                const v = insert.params.find(([id]) => id === spec.id)?.[1] ?? spec.default;
                                return <ParamControl key={spec.id} insert={insert} spec={spec} value={v} />;
                            })}
                        </div>
                    )}
                </motion.section>
            ) : null}
        </AnimatePresence>
    );
}
