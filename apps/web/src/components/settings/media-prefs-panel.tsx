"use client";

/**
 * Settings › Media (WP11-06): region, preferred providers, hide watched,
 * Listen section, AI curator. Saves through `saveWatchPrefs` (optimistic
 * local state, toast on result) — same pattern as `WatchPrefsPanel`, which
 * is rendered below this panel by the page for subtitles & co.
 */
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
    Card, CardContent, CardDescription, CardHeader, CardTitle,
    Checkbox, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch,
} from "@mmo/ui";
import { saveWatchPrefs } from "@/actions/watch-prefs";
import { MEDIA_PROVIDERS, MEDIA_REGIONS, type WatchPrefs } from "@/lib/watch-prefs";
import { cn } from "@/lib/utils";

export interface MediaPrefsPanelProps {
    initial: WatchPrefs;
    /** Whether the server has an AI key (curator is a no-op without one). */
    curatorAvailable: boolean;
}

function SwitchRow({ id, label, hint, checked, disabled, onChange }: {
    id: string; label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void;
}) {
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
                <Label htmlFor={id}>{label}</Label>
                {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
            </div>
            <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
        </div>
    );
}

export function MediaPrefsPanel({ initial, curatorAvailable }: MediaPrefsPanelProps) {
    const t = useTranslations("settings.media");
    const [prefs, setPrefs] = useState<WatchPrefs>(initial);
    const [pending, start] = useTransition();

    function persist(next: Partial<WatchPrefs>) {
        const prev = prefs;
        setPrefs({ ...prefs, ...next });
        start(async () => {
            const r = await saveWatchPrefs(next);
            if (r.ok) { setPrefs(r.prefs); toast.success(t("saved")); }
            else { setPrefs(prev); toast.error(t("saveFailed")); }
        });
    }

    function setRegion(code: string) {
        const regions = prefs.regions.includes(code) ? prefs.regions : [code, ...prefs.regions];
        persist({ defaultRegion: code, regions });
    }

    function toggleProvider(id: number, on: boolean) {
        const set = new Set(prefs.preferredProviders);
        if (on) set.add(id); else set.delete(id);
        persist({ preferredProviders: MEDIA_PROVIDERS.map((p) => p.id).filter((x) => set.has(x)) });
    }

    return (
        <div className="space-y-6" aria-busy={pending}>
            <Card>
                <CardHeader>
                    <CardTitle>{t("region.title")}</CardTitle>
                    <CardDescription>{t("region.description")}</CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-col gap-2 sm:max-w-xs">
                        <Label htmlFor="media-region">{t("region.label")}</Label>
                        <Select value={prefs.defaultRegion} onValueChange={(v) => { if (typeof v === "string") setRegion(v); }} disabled={pending}>
                            <SelectTrigger id="media-region" className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {MEDIA_REGIONS.map((code) => (
                                    <SelectItem key={code} value={code}>{t(`region.codes.${code}`)}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("providers.title")}</CardTitle>
                    <CardDescription>{t("providers.description")}</CardDescription>
                </CardHeader>
                <CardContent>
                    <div role="group" aria-label={t("providers.title")} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {MEDIA_PROVIDERS.map((p) => {
                            const id = `provider-${p.id}`;
                            const on = prefs.preferredProviders.includes(p.id);
                            return (
                                <label
                                    key={p.id}
                                    htmlFor={id}
                                    className={cn(
                                        "flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 transition-colors duration-(--dur-fast)",
                                        on ? "border-primary/60 bg-primary/5" : "hover:bg-muted/50",
                                    )}
                                >
                                    <Checkbox id={id} checked={on} disabled={pending} onCheckedChange={(v) => toggleProvider(p.id, v === true)} />
                                    <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
                                        {p.name.charAt(0)}
                                    </span>
                                    <span className="truncate text-sm">{p.name}</span>
                                </label>
                            );
                        })}
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("home.title")}</CardTitle>
                    <CardDescription>{t("home.description")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <SwitchRow id="media-hide-watched" label={t("home.hideWatched")} hint={t("home.hideWatchedHint")} checked={prefs.hideWatched} disabled={pending} onChange={(v) => persist({ hideWatched: v })} />
                    <SwitchRow id="media-show-listen" label={t("home.showListen")} hint={t("home.showListenHint")} checked={prefs.showListen} disabled={pending} onChange={(v) => persist({ showListen: v })} />
                    <SwitchRow
                        id="media-curator"
                        label={t("home.curator")}
                        hint={curatorAvailable ? t("home.curatorHint") : t("home.curatorUnavailable")}
                        checked={prefs.curator}
                        disabled={pending}
                        onChange={(v) => persist({ curator: v })}
                    />
                </CardContent>
            </Card>
        </div>
    );
}
