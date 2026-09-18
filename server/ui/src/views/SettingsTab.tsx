import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Separator, Skeleton, Switch, ThemeSettings, useToast } from "@mmo/ui";
import { useT } from "../i18n";
import { errorMessage, ipc, type CompanionSettings } from "../lib/ipc";

type ToggleKey = "startAtLogin" | "closeToTray" | "startMinimized";

/** Settings tab body — lazy-loaded from MainView (pulls in ThemeSettings). */
export default function SettingsTab() {
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

    const toggles: Array<{ key: ToggleKey; label: string; desc: string }> = [
        { key: "startAtLogin", label: t("settings.startAtLogin"), desc: t("settings.startAtLogin.desc") },
        { key: "closeToTray", label: t("settings.closeToTray"), desc: t("settings.closeToTray.desc") },
        { key: "startMinimized", label: t("settings.startMinimized"), desc: t("settings.startMinimized.desc") },
    ];

    return (
        <>
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
        </>
    );
}
