import { useCallback, useEffect, useState, type FormEvent } from "react";
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
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Label,
    RadioGroup,
    RadioGroupItem,
    Skeleton,
    Switch,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
    useToast,
} from "@mmo/ui";
import { AudioLines, Download, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useT } from "../i18n";
import { ipc, type DriverProbe, type VATopology, type VirtualDevice } from "../lib/ipc";

type ProbeState = { kind: "checking" } | { kind: "failed"; error: string } | { kind: "ok"; probe: DriverProbe };

/**
 * Driver status + virtual device list. Ported 1:1 from the legacy
 * `vaRefreshStatus` / `vaRefreshList` / `vaInstall` / `vaUninstall` /
 * `vaPromptAdd` / `vaRename` / `vaToggle` / `vaRemove`. Every `va.*` IPC
 * resolves `{ ok, data } | { ok, error }` and errors are surfaced to the user
 * (driver ops involve UAC/sudo — a cancelled prompt must be visible).
 */
export function VirtualDevices() {
    const t = useT();
    const toast = useToast();
    const [probe, setProbe] = useState<ProbeState>({ kind: "checking" });
    const [devices, setDevices] = useState<VirtualDevice[] | null>(null);
    const [listError, setListError] = useState<string | null>(null);
    const [busy, setBusy] = useState<"install" | "uninstall" | null>(null);
    const [addOpen, setAddOpen] = useState(false);
    const [renaming, setRenaming] = useState<VirtualDevice | null>(null);
    const [removing, setRemoving] = useState<VirtualDevice | null>(null);

    const refreshStatus = useCallback(async () => {
        setProbe({ kind: "checking" });
        const res = await ipc().va.probe();
        setProbe(res.ok ? { kind: "ok", probe: res.data } : { kind: "failed", error: res.error });
    }, []);

    const refreshList = useCallback(async () => {
        const res = await ipc().va.list();
        if (!res.ok) {
            setListError(res.error);
            setDevices([]);
            return;
        }
        setListError(null);
        setDevices(res.data ?? []);
    }, []);

    const refresh = useCallback(async () => {
        await refreshStatus();
        await refreshList();
    }, [refreshStatus, refreshList]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const fail = (title: string, error: string) => toast.add({ type: "error", title, description: error });

    async function install() {
        setBusy("install");
        const res = await ipc().va.install();
        setBusy(null);
        if (!res.ok) fail(t("va.driver.installFailed"), res.error);
        await refresh();
    }

    async function uninstall() {
        setBusy("uninstall");
        const res = await ipc().va.uninstall();
        setBusy(null);
        if (!res.ok) fail(t("va.driver.uninstallFailed"), res.error);
        await refresh();
    }

    async function create(name: string, topology: VATopology) {
        const res = await ipc().va.create({ name, topology, channels: 2, sampleRate: 48000 });
        if (!res.ok) fail(t("va.devices.createFailed"), res.error);
        setAddOpen(false);
        await refreshList();
    }

    async function rename(id: string, newName: string) {
        const trimmed = newName.trim();
        setRenaming(null);
        if (!trimmed) {
            await refreshList();
            return;
        }
        const res = await ipc().va.rename(id, trimmed);
        if (!res.ok) fail(t("va.devices.renameFailed"), res.error);
        await refreshList();
    }

    async function setEnabled(id: string, enabled: boolean) {
        setDevices((cur) => cur?.map((d) => (d.id === id ? { ...d, enabled } : d)) ?? cur);
        const res = await ipc().va.setEnabled(id, enabled);
        if (!res.ok) fail(enabled ? t("va.devices.enableFailed") : t("va.devices.disableFailed"), res.error);
        await refreshList();
    }

    async function remove(id: string) {
        setRemoving(null);
        const res = await ipc().va.remove(id);
        if (!res.ok) fail(t("va.devices.removeFailed"), res.error);
        await refreshList();
    }

    const canAdd = probe.kind === "ok" && probe.probe.available && probe.probe.supportsRuntimeCreate;

    return (
        <>
            {/* Driver status */}
            <div
                role="status"
                className={cn(
                    "flex items-center gap-3 rounded-lg border px-3 py-2.5",
                    probe.kind === "checking" && "bg-muted/30",
                    probe.kind === "ok" && probe.probe.available && "border-success/40 bg-success/10",
                    (probe.kind === "failed" || (probe.kind === "ok" && !probe.probe.available)) && "border-destructive/40 bg-destructive/10",
                )}
            >
                <span
                    className={cn(
                        "size-2.5 shrink-0 rounded-full",
                        probe.kind === "checking" && "bg-muted-foreground motion-full:animate-pulse",
                        probe.kind === "ok" && probe.probe.available && "bg-success",
                        (probe.kind === "failed" || (probe.kind === "ok" && !probe.probe.available)) && "bg-destructive",
                    )}
                    aria-hidden
                />
                <div className="min-w-0 flex-1 text-xs leading-snug">
                    <div className="font-semibold">
                        {probe.kind === "checking" && t("va.driver.checking")}
                        {probe.kind === "failed" && t("va.driver.probeFailed")}
                        {probe.kind === "ok" && (probe.probe.available ? t("va.driver.ready") : t("va.driver.missing"))}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                        {probe.kind === "failed" && probe.error}
                        {probe.kind === "ok" &&
                            (probe.probe.available
                                ? [
                                      probe.probe.version,
                                      probe.probe.maxDevices !== 0
                                          ? probe.probe.maxDevices === -1
                                              ? t("va.driver.unlimited")
                                              : t("va.driver.maxDevices", { max: probe.probe.maxDevices })
                                          : null,
                                  ]
                                      .filter(Boolean)
                                      .join(" — ")
                                : probe.probe.reason ?? "")}
                    </div>
                </div>
                {probe.kind === "ok" &&
                    (probe.probe.available ? (
                        <AlertDialog>
                            <AlertDialogTrigger
                                render={
                                    <Button variant="outline" size="xs" loading={busy === "uninstall"}>
                                        {busy === "uninstall" ? t("va.driver.uninstalling") : t("va.driver.uninstall")}
                                    </Button>
                                }
                            />
                            <AlertDialogContent size="sm">
                                <AlertDialogHeader>
                                    <AlertDialogTitle>{t("va.driver.uninstallTitle")}</AlertDialogTitle>
                                    <AlertDialogDescription>{t("va.driver.uninstallDesc")}</AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                                    <AlertDialogAction variant="destructive" onClick={() => void uninstall()}>
                                        {t("va.driver.uninstall")}
                                    </AlertDialogAction>
                                </AlertDialogFooter>
                            </AlertDialogContent>
                        </AlertDialog>
                    ) : (
                        <Button size="sm" onClick={install} loading={busy === "install"}>
                            {busy !== "install" && <Download className="size-4" aria-hidden />}
                            {busy === "install" ? t("va.driver.installing") : t("va.driver.install")}
                        </Button>
                    ))}
            </div>

            {/* Device list */}
            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                        <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("va.devices.title")}</CardTitle>
                        <div className="flex items-center gap-1">
                            <Button variant="outline" size="xs" onClick={() => void refresh()}>
                                <RefreshCw className="size-3.5" aria-hidden />
                                {t("va.devices.refresh")}
                            </Button>
                            <Button variant="default" size="xs" onClick={() => setAddOpen(true)} disabled={!canAdd}>
                                <Plus className="size-3.5" aria-hidden />
                                {t("va.devices.add")}
                            </Button>
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    {devices === null ? (
                        <div className="space-y-2">
                            <Skeleton className="h-12 w-full" />
                            <Skeleton className="h-12 w-full" />
                        </div>
                    ) : listError ? (
                        <p role="alert" className="py-3 text-center text-xs text-destructive">
                            {listError}
                        </p>
                    ) : devices.length === 0 ? (
                        <EmptyState
                            variant="inline"
                            icon={<AudioLines className="size-6" aria-hidden />}
                            title={t("va.devices.empty")}
                            description={t("va.devices.emptyDesc")}
                            actions={
                                canAdd ? (
                                    <Button size="sm" onClick={() => setAddOpen(true)}>
                                        <Plus className="size-4" aria-hidden />
                                        {t("va.devices.add")}
                                    </Button>
                                ) : undefined
                            }
                        />
                    ) : (
                        <ul className="space-y-1.5">
                            {devices.map((d) => (
                                <li
                                    key={d.id}
                                    className={cn("flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2", !d.enabled && "opacity-60")}
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="select-text truncate text-sm font-semibold">{d.name}</div>
                                        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                                            <Badge variant={d.topology === "loopback" ? "warning" : "info"} className="px-1.5 py-0 text-[9px]">
                                                {t(d.topology === "loopback" ? "va.devices.topology.loopback" : "va.devices.topology.independent")}
                                            </Badge>
                                            {d.source === "preexisting" && (
                                                <Badge variant="outline" className="px-1.5 py-0 text-[9px]">
                                                    {t("va.devices.preexisting")}
                                                </Badge>
                                            )}
                                            <span className="tabular-nums">
                                                {d.channels}ch · {(d.sampleRate / 1000).toFixed(1)}kHz
                                            </span>
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        <Tooltip>
                                            <TooltipTrigger
                                                render={
                                                    <span className="inline-flex">
                                                        <Switch size="sm" checked={d.enabled} onCheckedChange={(v) => void setEnabled(d.id, v)} aria-label={d.enabled ? t("va.devices.disableHint") : t("va.devices.enableHint")} />
                                                    </span>
                                                }
                                            />
                                            <TooltipContent>{d.enabled ? t("va.devices.disableHint") : t("va.devices.enableHint")}</TooltipContent>
                                        </Tooltip>
                                        <Button variant="ghost" size="icon-xs" onClick={() => setRenaming(d)} disabled={d.source === "preexisting"} aria-label={t("va.devices.rename")}>
                                            <Pencil className="size-3.5" aria-hidden />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon-xs"
                                            className="text-destructive hover:text-destructive"
                                            onClick={() => setRemoving(d)}
                                            disabled={d.source === "preexisting"}
                                            aria-label={t("va.devices.remove")}
                                        >
                                            <Trash2 className="size-3.5" aria-hidden />
                                        </Button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </CardContent>
            </Card>

            <AddDeviceDialog open={addOpen} onOpenChange={setAddOpen} onCreate={create} />

            <RenameDialog device={renaming} onClose={() => setRenaming(null)} onRename={rename} />

            <AlertDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
                <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                        <AlertDialogTitle>{t("va.devices.removeTitle", { name: removing?.name ?? "" })}</AlertDialogTitle>
                        <AlertDialogDescription>{t("va.devices.removeDesc")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => removing && void remove(removing.id)}>
                            {t("va.devices.remove")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}

function AddDeviceDialog({
    open,
    onOpenChange,
    onCreate,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreate: (name: string, topology: VATopology) => Promise<void>;
}) {
    const t = useT();
    const [name, setName] = useState("MMO-Deck");
    const [topology, setTopology] = useState<VATopology>("independent");
    const [submitting, setSubmitting] = useState(false);

    async function submit(e: FormEvent) {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) return;
        setSubmitting(true);
        try {
            await onCreate(trimmed, topology);
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={(o) => onOpenChange(o)}>
            <DialogContent size="sm" mobile="center">
                <form onSubmit={submit} className="contents">
                    <DialogHeader>
                        <DialogTitle>{t("va.add.title")}</DialogTitle>
                        <DialogDescription>{t("va.add.desc")}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                        <div className="space-y-1.5">
                            <Label htmlFor="va-add-name">{t("va.add.name")}</Label>
                            <Input id="va-add-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("va.add.namePlaceholder")} autoFocus required />
                        </div>
                        <div className="space-y-1.5">
                            <Label>{t("va.add.topology")}</Label>
                            <RadioGroup value={topology} onValueChange={(v) => setTopology(v as VATopology)} className="gap-2">
                                <label className="flex items-center gap-2 text-sm">
                                    <RadioGroupItem value="independent" />
                                    {t("va.add.topology.independent")}
                                </label>
                                <label className="flex items-center gap-2 text-sm">
                                    <RadioGroupItem value="loopback" />
                                    {t("va.add.topology.loopback")}
                                </label>
                            </RadioGroup>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            {t("common.cancel")}
                        </Button>
                        <Button type="submit" loading={submitting}>
                            {t("va.add.create")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function RenameDialog({
    device,
    onClose,
    onRename,
}: {
    device: VirtualDevice | null;
    onClose: () => void;
    onRename: (id: string, name: string) => Promise<void>;
}) {
    const t = useT();
    const [name, setName] = useState("");
    const [key, setKey] = useState<string | null>(null);
    // Reset the draft when a different device is opened (derived state, no effect).
    if (device && device.id !== key) {
        setKey(device.id);
        setName(device.name);
    }

    async function submit(e: FormEvent) {
        e.preventDefault();
        if (!device) return;
        await onRename(device.id, name);
    }

    return (
        <Dialog open={device !== null} onOpenChange={(o) => !o && onClose()}>
            <DialogContent size="sm" mobile="center">
                <form onSubmit={submit} className="contents">
                    <DialogHeader>
                        <DialogTitle>{t("va.rename.title")}</DialogTitle>
                    </DialogHeader>
                    <div className="py-2">
                        <Label htmlFor="va-rename" className="sr-only">
                            {t("va.add.name")}
                        </Label>
                        <Input id="va-rename" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>
                            {t("common.cancel")}
                        </Button>
                        <Button type="submit">{t("va.rename.save")}</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
