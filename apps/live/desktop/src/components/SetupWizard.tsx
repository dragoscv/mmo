/**
 * First-run / audio setup: host, input + channels, output + main pair + optional in-ear pair, buffer
 * with live nominal latency, Voicemeeter badge + recommended routing, real latency measurement, Start.
 */
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { Activity, Loader2, Play, RefreshCw, Sparkles } from "lucide-react";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    ToggleGroup,
    ToggleGroupItem,
} from "@mmo/ui";
import { useT } from "../i18n";
import {
    BUFFERS,
    RATES,
    channelPairs,
    findDevice,
    hasVoicemeeter,
    inputs,
    nominalLatencyMs,
    outputs,
    recommendRouting,
    routingHint,
    type DeviceInfo,
    type DevicesResponse,
} from "../lib/routing";
import { api, isTauri, type EngineConfig, type LatencyResult } from "../lib/tauri";
import { latencyBudget } from "../lib/latency-budget";
import { useMeterSample } from "../lib/meter-bus";
import { useStore } from "../store";

const AUTO = "__auto__";
const NONE = "__none__";

function Field({ label, id, children, hint }: { label: string; id: string; children: ReactNode; hint?: string }) {
    return (
        <div className="flex flex-col gap-1.5">
            <span id={id} className="text-sm font-medium">
                {label}
            </span>
            {children}
            {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
        </div>
    );
}

function DevicePick({ id, label, list, value, onChange }: { id: string; label: string; list: DeviceInfo[]; value: string; onChange: (v: string) => void }) {
    const t = useT();
    const items = Object.fromEntries(list.map((d) => [d.id, d.name]));
    return (
        <Field label={label} id={id}>
            <Select items={items} value={value || null} onValueChange={(v) => v && onChange(String(v))}>
                <SelectTrigger aria-labelledby={id} className="w-full">
                    <SelectValue placeholder={t("setup.pick")} />
                </SelectTrigger>
                <SelectContent>
                    {list.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                            <span className="flex items-center gap-2">
                                {d.name}
                                {d.voicemeeter ? <Badge variant="info">VM</Badge> : d.virtual_cable ? <Badge variant="secondary">{t("setup.virtualCable")}</Badge> : null}
                            </span>
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </Field>
    );
}

function PairPick({ id, label, channels, value, onChange, allowNone }: { id: string; label: string; channels: number; value: string; onChange: (v: string) => void; allowNone?: boolean }) {
    const t = useT();
    const pairs = channelPairs(channels);
    const items: Record<string, string> = {};
    if (allowNone) items[NONE] = t("setup.monitorNone");
    for (const [a, b] of pairs) items[`${a},${b}`] = a === b ? t("setup.channel", { n: a + 1 }) : t("setup.pair", { a: a + 1, b: b + 1 });
    return (
        <Field label={label} id={id}>
            <Select items={items} value={value} onValueChange={(v) => v && onChange(String(v))}>
                <SelectTrigger aria-labelledby={id} className="w-full">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {Object.entries(items).map(([k, v]) => (
                        <SelectItem key={k} value={k}>
                            {v}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </Field>
    );
}

interface Draft {
    host: string;
    input: string;
    output: string;
    inCh: string;
    main: string;
    monitor: string;
    buffer: number;
    rate: number;
}

const toPair = (s: string): [number, number] => {
    const [a = 0, b = a] = s.split(",").map(Number);
    return [a, b];
};

export function SetupWizard() {
    const t = useT();
    const open = useStore((s) => s.panel === "setup");
    const openPanel = useStore((s) => s.openPanel);
    const settings = useStore((s) => s.settings);
    const status = useStore((s) => s.status);
    const engine = useStore((s) => s.start);
    const setMeasuredRoundTrip = useStore((s) => s.setMeasuredRoundTrip);
    const meters = useMeterSample(4);
    const startEngine = useStore((s) => s.startEngine);
    const currentPreset = useStore((s) => s.proto.state?.preset);
    const canClose = !!settings.device;

    const [data, setData] = useState<DevicesResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [latency, setLatency] = useState<LatencyResult | null>(null);
    const [measuring, setMeasuring] = useState(false);
    const [draft, setDraft] = useState<Draft>(() => {
        const d = settings.device;
        return {
            host: d?.host ?? AUTO,
            input: d?.input ?? "",
            output: d?.output ?? "",
            inCh: (d?.inputChannels ?? [0]).join(","),
            main: (d?.main ?? [0, 1]).join(","),
            monitor: d?.monitor ? d.monitor.join(",") : NONE,
            buffer: d?.buffer ?? 128,
            rate: d?.rate ?? 48_000,
        };
    });
    const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

    const load = useCallback(async (host: string) => {
        if (!isTauri()) return;
        setLoading(true);
        setError(null);
        try {
            const res = await api.listDevices(host === AUTO ? null : host);
            setData(res);
            setDraft((d) => {
                const ins = inputs(res.devices);
                const outs = outputs(res.devices);
                const rec = recommendRouting(res.devices);
                const inDev = findDevice(ins, d.input) ?? rec.input ?? ins[0];
                const outDev = findDevice(outs, d.output) ?? rec.output ?? outs[0];
                return { ...d, input: inDev?.id ?? "", output: outDev?.id ?? "" };
            });
        } catch (e) {
            setError(t("errors.devices", { message: e instanceof Error ? e.message : String(e) }));
        } finally {
            setLoading(false);
        }
    }, [t]);

    useEffect(() => {
        if (open) void load(draft.host);
        // Reload only when the dialog opens or the host changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, draft.host]);

    const devices = data?.devices ?? [];
    const ins = inputs(devices);
    const outs = outputs(devices);
    const inDev = findDevice(ins, draft.input);
    const outDev = findDevice(outs, draft.output);
    const rec = useMemo(() => recommendRouting(devices), [devices]);
    const hint = routingHint(inDev, outDev);
    const nominal = nominalLatencyMs(draft.buffer, draft.rate);
    // What the engine declares per stage, against what the probe measured: the budget block below.
    // Without a running engine the declared side is the settings being chosen (equal periods, the
    // cushion the fixed mode keeps), so the block is useful before anything is started.
    const budget = latencyBudget(
        engine?.info ?? {
            host: draft.host,
            input: inDev?.name ?? "",
            output: outDev?.name ?? "",
            sample_rate: draft.rate,
            buffer_frames: draft.buffer,
            input_channels: inDev?.input_channels ?? 0,
            output_channels: outDev?.output_channels ?? 0,
            nominal_latency_ms: nominal,
            input_period_frames: draft.buffer,
            cushion_frames: draft.buffer,
            output_period_frames: draft.buffer,
            notes: [],
        },
        meters,
        latency?.round_trip_ms ?? null,
    );

    const config = (): EngineConfig | null => {
        if (!inDev || !outDev) return null;
        const inCh = draft.inCh.split(",").map(Number).filter((n) => n < inDev.input_channels);
        return {
            host: draft.host === AUTO ? null : draft.host,
            input: inDev.name,
            output: outDev.name,
            rate: draft.rate,
            buffer: draft.buffer,
            inputChannels: inCh.length ? inCh : [0],
            main: toPair(draft.main),
            monitor: draft.monitor === NONE ? null : toPair(draft.monitor),
            preset: currentPreset ?? settings.lastPreset ?? "Natural Vocal",
            lan: settings.lan,
            port: 17920,
        };
    };

    const measure = async () => {
        const c = config();
        if (!c) return;
        setMeasuring(true);
        setError(null);
        setLatency(null);
        try {
            const result = await api.measureLatency(c);
            setLatency(result);
            // The overlay on the performance screen reads the same figure.
            setMeasuredRoundTrip(result.round_trip_ms);
        } catch (e) {
            setError(t("errors.latency", { message: e instanceof Error ? e.message : String(e) }));
        } finally {
            setMeasuring(false);
        }
    };

    const start = async () => {
        const c = config();
        if (!c) return;
        if (await startEngine(c)) openPanel(null);
    };

    const inChItems: Record<string, string> = {};
    if (inDev) {
        for (let i = 0; i < inDev.input_channels; i++) inChItems[String(i)] = t("setup.channel", { n: i + 1 });
        for (const [a, b] of channelPairs(inDev.input_channels)) if (a !== b) inChItems[`${a},${b}`] = t("setup.pair", { a: a + 1, b: b + 1 });
    }
    const hostItems: Record<string, string> = { [AUTO]: t("setup.hostAuto") };
    for (const h of data?.hosts ?? []) hostItems[h] = h;
    const starting = status === "starting";

    return (
        <Dialog open={open} onOpenChange={(o) => (o || canClose) && openPanel(o ? "setup" : null)}>
            <DialogContent size="xl" showCloseButton={canClose} className="max-h-[92vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        {t("setup.title")}
                        {hasVoicemeeter(devices) ? (
                            <motion.span initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}>
                                <Badge variant="info">{t("setup.voicemeeter")}</Badge>
                            </motion.span>
                        ) : null}
                    </DialogTitle>
                    <DialogDescription>{t("setup.subtitle")}</DialogDescription>
                </DialogHeader>

                <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                    <div className="flex flex-col gap-4">
                        <Field label={t("setup.host")} id="setup-host">
                            <div className="flex gap-2">
                                <Select items={hostItems} value={draft.host} onValueChange={(v) => v && patch({ host: String(v), input: "", output: "" })}>
                                    <SelectTrigger aria-labelledby="setup-host" className="w-full">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {Object.entries(hostItems).map(([k, v]) => (
                                            <SelectItem key={k} value={k}>
                                                {v}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <Button variant="outline" size="icon" aria-label={t("setup.refresh")} onClick={() => void load(draft.host)} disabled={loading}>
                                    {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                                </Button>
                            </div>
                        </Field>
                        {loading && !data ? <p className="text-sm text-muted-foreground">{t("setup.loading")}</p> : null}
                        {data && devices.length === 0 ? <p className="text-sm text-muted-foreground">{t("setup.noDevices")}</p> : null}
                        <DevicePick id="setup-in" label={t("setup.input")} list={ins} value={draft.input} onChange={(input) => patch({ input, inCh: "0" })} />
                        {inDev ? (
                            <Field label={t("setup.inputChannels")} id="setup-inch" hint={t("setup.inputChannelsHint")}>
                                <Select items={inChItems} value={draft.inCh} onValueChange={(v) => v && patch({ inCh: String(v) })}>
                                    <SelectTrigger aria-labelledby="setup-inch" className="w-full">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {Object.entries(inChItems).map(([k, v]) => (
                                            <SelectItem key={k} value={k}>
                                                {v}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                        ) : null}
                        <DevicePick id="setup-out" label={t("setup.output")} list={outs} value={draft.output} onChange={(output) => patch({ output, main: "0,1", monitor: NONE })} />
                        {outDev ? (
                            <div className="grid grid-cols-2 gap-3">
                                <PairPick id="setup-main" label={t("setup.mainPair")} channels={outDev.output_channels} value={draft.main} onChange={(main) => patch({ main })} />
                                <PairPick
                                    id="setup-mon"
                                    label={t("setup.monitorPair")}
                                    channels={outDev.output_channels}
                                    value={draft.monitor}
                                    allowNone
                                    onChange={(monitor) => patch({ monitor })}
                                />
                            </div>
                        ) : null}
                    </div>

                    <div className="flex flex-col gap-4">
                        <Field label={t("setup.buffer")} id="setup-buf" hint={t("setup.nominal", { ms: nominal.toFixed(1) })}>
                            <ToggleGroup
                                variant="outline"
                                aria-labelledby="setup-buf"
                                value={[String(draft.buffer)]}
                                onValueChange={(v) => v[0] && patch({ buffer: Number(v[0]) })}
                            >
                                {BUFFERS.map((b) => (
                                    <ToggleGroupItem key={b} value={String(b)} className="tabular-nums">
                                        {b}
                                    </ToggleGroupItem>
                                ))}
                            </ToggleGroup>
                        </Field>
                        <Field label={t("setup.sampleRate")} id="setup-rate">
                            <ToggleGroup variant="outline" aria-labelledby="setup-rate" value={[String(draft.rate)]} onValueChange={(v) => v[0] && patch({ rate: Number(v[0]) })}>
                                {RATES.map((r) => (
                                    <ToggleGroupItem key={r} value={String(r)} className="tabular-nums">
                                        {(r / 1000).toFixed(r % 1000 ? 1 : 0)} kHz
                                    </ToggleGroupItem>
                                ))}
                            </ToggleGroup>
                        </Field>

                        <div className="rounded-xl border bg-muted/40 p-3 text-sm">
                            <div className="mb-1 flex items-center gap-2 font-medium">
                                <Sparkles className="size-4 text-primary" /> {t("setup.recommendedTitle")}
                            </div>
                            <p className="text-muted-foreground">
                                {hint === "voicemeeter"
                                    ? t("setup.hintVoicemeeter", { output: outDev?.name ?? "" })
                                    : hint === "interface"
                                      ? t("setup.hintInterface")
                                      : hint === "different"
                                        ? t("setup.hintDifferent")
                                        : rec.kind === "voicemeeter"
                                          ? t("setup.hintVoicemeeter", { output: rec.output?.name ?? "" })
                                          : t("setup.hintInterface")}
                            </p>
                            {rec.input && rec.output && (rec.input.id !== inDev?.id || rec.output.id !== outDev?.id) ? (
                                <Button variant="link" size="sm" className="mt-1 h-auto p-0" onClick={() => patch({ input: rec.input?.id ?? "", output: rec.output?.id ?? "", inCh: "0", main: "0,1", monitor: NONE })}>
                                    {t("setup.applyRecommended")}
                                </Button>
                            ) : null}
                        </div>

                        <div className="flex flex-col gap-2 rounded-xl border p-3">
                            <Button variant="secondary" onClick={() => void measure()} disabled={!inDev || !outDev || measuring || starting} loading={measuring}>
                                <Activity /> {measuring ? t("setup.measuring") : t("setup.measure")}
                            </Button>
                            <p className="text-xs text-muted-foreground">{t("setup.measureHint")}</p>
                            {latency ? (
                                <p className="text-sm font-medium tabular-nums" role="status">
                                    {t("setup.measured", { ms: latency.round_trip_ms.toFixed(1), nominal: latency.nominal_ms.toFixed(1) })}
                                </p>
                            ) : null}
                            <div className="mt-1 border-t pt-2 text-xs text-muted-foreground" role="group" aria-label={t("setup.budgetTitle")}>
                                <p className="mb-1 font-medium text-foreground">{t("setup.budgetTitle")}</p>
                                <dl className="grid grid-cols-2 gap-x-3 tabular-nums">
                                    {budget.rows.map((r) => (
                                        <Fragment key={r.id}>
                                            <dt>{t(`setup.budget${r.id}`)}</dt>
                                            <dd className="text-end">{r.ms.toFixed(2)} ms</dd>
                                        </Fragment>
                                    ))}
                                    <dt className="font-medium text-foreground">{t("setup.budgetDeclared")}</dt>
                                    <dd className="text-end font-medium text-foreground">{budget.declaredMs.toFixed(2)} ms</dd>
                                    {budget.declaredEarsMs !== budget.declaredMs ? (
                                        <>
                                            <dt>{t("setup.budgetDeclaredEars")}</dt>
                                            <dd className="text-end">{budget.declaredEarsMs.toFixed(2)} ms</dd>
                                        </>
                                    ) : null}
                                    {budget.measuredMs != null ? (
                                        <>
                                            <dt>{t("setup.budgetMeasured")}</dt>
                                            <dd className="text-end">{budget.measuredMs.toFixed(2)} ms</dd>
                                            <dt>{t("setup.budgetRest")}</dt>
                                            <dd className="text-end">{(budget.restMs ?? 0).toFixed(2)} ms</dd>
                                        </>
                                    ) : null}
                                </dl>
                            </div>
                        </div>
                    </div>
                </div>

                {error ? (
                    <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                        {error}
                    </p>
                ) : null}

                <div className="flex justify-end gap-2">
                    {canClose ? (
                        <Button variant="outline" onClick={() => openPanel(null)}>
                            {t("setup.cancel")}
                        </Button>
                    ) : null}
                    <Button size="lg" onClick={() => void start()} disabled={!inDev || !outDev || starting || measuring} loading={starting}>
                        {!starting ? <Play /> : null} {starting ? t("setup.starting") : t("setup.start")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
