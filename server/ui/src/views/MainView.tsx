import { useEffect, useState } from "react";
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
    Avatar,
    AvatarFallback,
    AvatarImage,
    Badge,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Label,
    Separator,
    Skeleton,
    Switch,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    ThemeSettings,
    useToast,
} from "@mmo/ui";
import { LogOut } from "lucide-react";
import { useT } from "../i18n";
import { errorMessage, ipc, type CompanionSettings, type CompanionStatus } from "../lib/ipc";
import { DebugLogPanel } from "../components/DebugLogPanel";
import { UpdaterBar } from "../components/UpdaterBar";

type ToggleKey = "startAtLogin" | "closeToTray" | "startMinimized";

function initials(name: string | null): string {
    return (name || "?")
        .split(" ")
        .map((n) => n[0] ?? "")
        .join("")
        .toUpperCase()
        .slice(0, 2);
}

export function MainView({ status, onStatusRefresh }: { status: CompanionStatus; onStatusRefresh: () => Promise<unknown> }) {
    const t = useT();
    const toast = useToast();
    const [settings, setSettings] = useState<CompanionSettings | null>(null);

    useEffect(() => {
        let alive = true;
        ipc()
            .getSettings()
            .then((s) => alive && setSettings(s))
            .catch(() => {});
        return () => {
            alive = false;
        };
    }, []);

    /** Legacy `toggleSetting`: re-read, flip, write, re-render from the returned settings. */
    async function toggle(key: ToggleKey, next: boolean) {
        setSettings((cur) => (cur ? { ...cur, [key]: next } : cur));
        try {
            const updated = await ipc().updateSettings({ [key]: next });
            setSettings(updated);
        } catch (err) {
            toast.add({ type: "error", title: t("settings.saveFailed"), description: errorMessage(err) });
            try {
                setSettings(await ipc().getSettings());
            } catch {
                /* ignore */
            }
        }
    }

    async function disconnect() {
        await ipc().logout();
        await onStatusRefresh();
    }

    const serverTone = status.serverError ? "destructive" : status.port ? "success" : "warning";
    const serverText = status.serverError ? t("profile.serverError") : status.port ? t("profile.serverRunning") : t("profile.serverStarting");

    const toggles: Array<{ key: ToggleKey; label: string; desc: string }> = [
        { key: "startAtLogin", label: t("settings.startAtLogin"), desc: t("settings.startAtLogin.desc") },
        { key: "closeToTray", label: t("settings.closeToTray"), desc: t("settings.closeToTray.desc") },
        { key: "startMinimized", label: t("settings.startMinimized"), desc: t("settings.startMinimized.desc") },
    ];

    return (
        <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <div className="mx-auto flex max-w-[var(--content-sm)] flex-col gap-4">
                    {/* Profile */}
                    <Card>
                        <CardContent className="flex items-center gap-3 py-4">
                            <Avatar size="lg">
                                {status.userImage && <AvatarImage src={status.userImage} referrerPolicy="no-referrer" alt="" />}
                                <AvatarFallback className="bg-brand-gradient text-white">{initials(status.userName)}</AvatarFallback>
                            </Avatar>
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-semibold">{status.userName || t("profile.notConnected")}</div>
                                {status.userEmail && <div className="select-text truncate text-xs text-muted-foreground">{status.userEmail}</div>}
                                <div className="mt-1 flex items-center gap-1.5 text-[11px]">
                                    <Badge variant={serverTone} className="px-1.5 py-0 text-[10px]">
                                        <span className={serverTone === "success" ? "size-1.5 rounded-full bg-current shadow-[0_0_6px_currentColor]" : "size-1.5 rounded-full bg-current"} aria-hidden />
                                        {serverText}
                                    </Badge>
                                    {status.serverError && <span className="truncate text-destructive">{status.serverError}</span>}
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Tabs defaultValue="overview">
                        <TabsList variant="line" className="w-full">
                            <TabsTrigger value="overview">{t("tabs.overview")}</TabsTrigger>
                            <TabsTrigger value="settings">{t("tabs.settings")}</TabsTrigger>
                            <TabsTrigger value="debug">{t("tabs.debug")}</TabsTrigger>
                        </TabsList>

                        <TabsContent value="overview" className="mt-4 space-y-4">
                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("status.title")}</CardTitle>
                                </CardHeader>
                                <CardContent className="grid grid-cols-2 gap-2">
                                    <div className="rounded-lg bg-muted/50 p-3 text-center">
                                        <div className="truncate font-heading text-lg font-bold text-primary">{status.deviceName || status.userName || "—"}</div>
                                        <div className="text-[10px] text-muted-foreground">
                                            {t("status.deviceName")} · {t("status.deviceName.hint")}
                                        </div>
                                    </div>
                                    <div className="rounded-lg bg-muted/50 p-3 text-center">
                                        <div className="font-heading text-lg font-bold tabular-nums text-primary">{status.port || "—"}</div>
                                        <div className="text-[10px] text-muted-foreground">{t("status.port")}</div>
                                    </div>
                                    <p className="col-span-2 text-[11px] text-muted-foreground">{t("status.libraryHint")}</p>
                                </CardContent>
                            </Card>

                            <AlertDialog>
                                <AlertDialogTrigger
                                    render={
                                        <Button variant="outline" className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive">
                                            <LogOut className="size-4" aria-hidden />
                                            {t("disconnect.button")}
                                        </Button>
                                    }
                                />
                                <AlertDialogContent size="sm">
                                    <AlertDialogHeader>
                                        <AlertDialogTitle>{t("disconnect.title")}</AlertDialogTitle>
                                        <AlertDialogDescription>{t("disconnect.desc")}</AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                        <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                                        <AlertDialogAction variant="destructive" onClick={() => void disconnect()}>
                                            {t("disconnect.confirm")}
                                        </AlertDialogAction>
                                    </AlertDialogFooter>
                                </AlertDialogContent>
                            </AlertDialog>
                        </TabsContent>

                        <TabsContent value="settings" className="mt-4 space-y-4">
                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("settings.title")}</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    {settings ? (
                                        toggles.map((row, i) => (
                                            <div key={row.key}>
                                                {i > 0 && <Separator className="my-2" />}
                                                <div className="flex items-center justify-between gap-4 py-1">
                                                    <div>
                                                        <Label htmlFor={`toggle-${row.key}`} className="text-sm">
                                                            {row.label}
                                                        </Label>
                                                        <CardDescription className="text-[11px]">{row.desc}</CardDescription>
                                                    </div>
                                                    <Switch id={`toggle-${row.key}`} checked={!!settings[row.key]} onCheckedChange={(v) => void toggle(row.key, v)} />
                                                </div>
                                            </div>
                                        ))
                                    ) : (
                                        <div className="space-y-3">
                                            <Skeleton className="h-9 w-full" />
                                            <Skeleton className="h-9 w-full" />
                                            <Skeleton className="h-9 w-full" />
                                        </div>
                                    )}
                                </CardContent>
                            </Card>

                            <Card>
                                <CardContent className="pt-6">
                                    <ThemeSettings hide={["feedback"]} />
                                </CardContent>
                            </Card>
                        </TabsContent>

                        <TabsContent value="debug" className="mt-4">
                            <DebugLogPanel />
                        </TabsContent>
                    </Tabs>
                </div>
            </div>
            <UpdaterBar status={status} />
        </div>
    );
}
