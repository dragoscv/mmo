import { useCallback, useEffect, useRef, useState } from "react";
import {
    Badge,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Checkbox,
    Collapsible,
    CollapsiblePanel,
    CollapsibleTrigger,
    Skeleton,
    cn,
    useToast,
} from "@mmo/ui";
import { ChevronDown, Headphones, Mic, RefreshCw } from "lucide-react";
import { useT } from "../i18n";
import { authKey, errorMessage, mmo, type AudioBackendGroup, type AudioDeviceInfo, type AudioInventory, type AuthorizedAudioDevice } from "../lib/ipc";
import { LatencyWidget } from "./LatencyWidget";

/**
 * Physical inputs/outputs the web app's engine may use. Ported from the
 * legacy `loadAudioDevices` / `renderAudioDevices` / `toggleAudioAuth`:
 *  - spinner only when no cache yet; background pushes replace the list
 *  - an empty inventory with `initialLoadComplete === false` keeps the spinner
 *  - backend groups collapsed by default; expansion survives re-renders
 *  - authorization keyed on (backend, direction, name)
 */
export function PhysicalDevices() {
    const t = useT();
    const toast = useToast();
    const [inv, setInv] = useState<AudioInventory | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const invRef = useRef<AudioInventory | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

    const commit = (next: AudioInventory) => {
        invRef.current = next;
        setInv(next);
    };

    const load = useCallback(
        async (force = false) => {
            if (!mmo) return;
            setLoading(true);
            try {
                const res = await mmo.getAudioDevices(force ? { force: true } : undefined);
                if (res?.error && !invRef.current) {
                    setError(res.error);
                    return;
                }
                const isEmpty = !res || !Array.isArray(res.backends) || res.backends.length === 0;
                if (isEmpty && res && res.initialLoadComplete === false) return; // push will arrive shortly
                setError(null);
                commit({ backends: res.backends ?? [], authorized: res.authorized ?? [] });
            } catch (err) {
                if (!invRef.current) setError(`${t("physical.failed")}: ${errorMessage(err)}`);
            } finally {
                setLoading(false);
            }
        },
        [t],
    );

    useEffect(() => {
        void load();
        if (!mmo) return;
        return mmo.onAudioDevicesUpdated((data) => {
            if (!data) return;
            setError(null);
            commit({ backends: data.backends ?? [], authorized: data.authorized ?? [] });
        });
    }, [load]);

    async function toggleAuth(dev: AuthorizedAudioDevice, checked: boolean) {
        const cur = invRef.current;
        if (!cur || !mmo) return;
        const k = authKey(dev);
        const current = cur.authorized ?? [];
        const next = checked ? (current.some((a) => authKey(a) === k) ? current : current.concat(dev)) : current.filter((a) => authKey(a) !== k);
        commit({ ...cur, authorized: next }); // optimistic
        try {
            const result = await mmo.setAuthorizedAudioDevices(next);
            if (result?.authorized) commit({ ...cur, authorized: result.authorized });
        } catch (err) {
            toast.add({ type: "error", title: t("physical.saveFailed"), description: errorMessage(err) });
            commit(cur); // restore
        }
    }

    const authorized = new Set((inv?.authorized ?? []).map(authKey));

    return (
        <Card>
            <CardHeader>
                <div className="flex items-start justify-between gap-2">
                    <div>
                        <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("physical.title")}</CardTitle>
                        <CardDescription className="text-[11px]">{t("physical.hint")}</CardDescription>
                    </div>
                    <Button variant="outline" size="xs" onClick={() => void load(true)} disabled={loading}>
                        <RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden />
                        {t("debug.refresh")}
                    </Button>
                </div>
            </CardHeader>
            <CardContent className="space-y-3">
                {error && !inv ? (
                    <p role="alert" className="py-3 text-center text-xs text-destructive">
                        {error}
                    </p>
                ) : !inv ? (
                    <div className="space-y-2" aria-busy aria-label={t("physical.loading")}>
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-full" />
                    </div>
                ) : inv.backends.length === 0 ? (
                    <p className="py-3 text-center text-xs text-muted-foreground">{t("physical.noBackends")}</p>
                ) : (
                    <div className="space-y-2">
                        {inv.backends.map((group) => (
                            <BackendGroup
                                key={group.backend}
                                group={group}
                                open={expanded.has(group.backend)}
                                onOpenChange={(open) =>
                                    setExpanded((s) => {
                                        const n = new Set(s);
                                        if (open) n.add(group.backend);
                                        else n.delete(group.backend);
                                        return n;
                                    })
                                }
                                authorized={authorized}
                                onToggle={toggleAuth}
                            />
                        ))}
                    </div>
                )}
                <LatencyWidget />
            </CardContent>
        </Card>
    );
}

function BackendGroup({
    group,
    open,
    onOpenChange,
    authorized,
    onToggle,
}: {
    group: AudioBackendGroup;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    authorized: Set<string>;
    onToggle: (dev: AuthorizedAudioDevice, checked: boolean) => void;
}) {
    const t = useT();
    const devices = group.devices ?? [];
    const inputs = devices.filter((d) => d.inputChannels > 0);
    const outputs = devices.filter((d) => d.outputChannels > 0);

    return (
        <Collapsible open={open} onOpenChange={(o) => onOpenChange(o)} className="rounded-md border">
            <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted/50">
                <span className="flex items-center gap-1.5">
                    <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} aria-hidden />
                    {group.apiName}
                </span>
                <Badge variant={group.available ? "success" : "secondary"} className="px-1.5 py-0 text-[9px]">
                    {group.available ? t("physical.summary", { inputs: inputs.length, outputs: outputs.length }) : t("physical.unavailableShort")}
                </Badge>
            </CollapsibleTrigger>
            <CollapsiblePanel>
                <div className="px-2 pb-2">
                    {!group.available ? (
                        <p className="py-2 text-center text-xs text-muted-foreground">{t("physical.unavailable")}</p>
                    ) : devices.length === 0 ? (
                        <p className="py-2 text-center text-xs text-muted-foreground">{t("physical.noDevices")}</p>
                    ) : (
                        <>
                            <Direction icon={<Mic className="size-3" aria-hidden />} label={t("physical.inputs")} devices={inputs} backend={group.backend} direction="input" authorized={authorized} onToggle={onToggle} />
                            <Direction icon={<Headphones className="size-3" aria-hidden />} label={t("physical.outputs")} devices={outputs} backend={group.backend} direction="output" authorized={authorized} onToggle={onToggle} />
                        </>
                    )}
                </div>
            </CollapsiblePanel>
        </Collapsible>
    );
}

function Direction({
    icon,
    label,
    devices,
    backend,
    direction,
    authorized,
    onToggle,
}: {
    icon: React.ReactNode;
    label: string;
    devices: AudioDeviceInfo[];
    backend: string;
    direction: "input" | "output";
    authorized: Set<string>;
    onToggle: (dev: AuthorizedAudioDevice, checked: boolean) => void;
}) {
    const t = useT();
    return (
        <div className="mt-2">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {icon}
                <span>{label}</span>
                <span className="ml-auto tabular-nums">{devices.length === 0 ? t("physical.none") : devices.length}</span>
            </div>
            {devices.map((d) => {
                const auth: AuthorizedAudioDevice = { backend, direction, name: d.name, preferredSampleRate: d.preferredSampleRate };
                const checked = authorized.has(authKey(auth));
                const isDefault = direction === "input" ? d.isDefaultInput : d.isDefaultOutput;
                const channels = direction === "input" ? d.inputChannels : d.outputChannels;
                const id = `dev-${backend}-${direction}-${d.name}`.replace(/\W+/g, "-");
                return (
                    <label
                        key={id}
                        htmlFor={id}
                        className={cn(
                            "mb-1 flex cursor-pointer items-start gap-2 rounded-md border border-transparent bg-muted/30 px-2 py-1.5 transition-colors hover:border-border",
                            checked && "border-primary/40 bg-primary/5",
                        )}
                    >
                        <Checkbox id={id} checked={checked} onCheckedChange={(v) => onToggle(auth, v)} className="mt-0.5" />
                        <span className="min-w-0 flex-1">
                            <span className="line-clamp-2 text-xs font-medium leading-snug">
                                {d.name}
                                {isDefault && (
                                    <Badge variant="outline" className="ml-1 px-1 py-0 align-middle text-[9px] text-primary">
                                        {t("physical.default")}
                                    </Badge>
                                )}
                            </span>
                            <span className="block text-[10px] text-muted-foreground">{t("physical.meta", { channels, rate: d.preferredSampleRate })}</span>
                        </span>
                    </label>
                );
            })}
        </div>
    );
}
