import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw, Sparkles } from "lucide-react";
import { Badge, Button, Tooltip, TooltipContent, TooltipTrigger } from "@mmo/ui";
import { engine } from "@/bridge/engine";
import { useT } from "@/i18n";
import { useShellPrefs } from "@/shell/shell-prefs";
import { useUiStore } from "@/state/ui-store";
import { APP_DOCS_URL, APP_LICENCE, APP_LICENCE_URL, APP_VERSION } from "../app-info";
import { Section } from "../sections/shared";

export function AboutTab() {
    const t = useT();
    const [native, setNative] = useState<boolean | null>(null);
    useEffect(() => {
        void engine.isNative().then(setNative);
    }, []);

    return (
        <div className="grid gap-6">
            <Section title={t("settings.aboutVersion")} settingId="about.version">
                <div className="grid gap-1">
                    <p className="font-heading text-lg font-semibold">MixAI Decks</p>
                    <p className="text-sm text-muted-foreground">{t("settings.aboutTagline")}</p>
                </div>
                <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2 text-sm">
                    <dt className="text-muted-foreground">{t("settings.aboutVersion")}</dt>
                    <dd className="mono">{APP_VERSION}</dd>
                    <dt className="text-muted-foreground">{t("settings.aboutEngine")}</dt>
                    <dd>
                        {native === null ? "…" : <Badge variant={native ? "default" : "secondary"}>{native ? t("settings.aboutNative") : t("settings.aboutPreview")}</Badge>}
                    </dd>
                    <dt className="text-muted-foreground">{t("settings.aboutDocs")}</dt>
                    <dd>
                        <a href={APP_DOCS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">
                            decks.mixai.ro <ExternalLink className="size-3" aria-hidden />
                        </a>
                    </dd>
                    <dt className="text-muted-foreground">{t("settings.aboutLicence")}</dt>
                    <dd>
                        <a href={APP_LICENCE_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">
                            {APP_LICENCE} <ExternalLink className="size-3" aria-hidden />
                        </a>
                    </dd>
                </dl>
                <div data-setting-id="about.tour" className="grid scroll-mt-4 gap-1 rounded-lg data-[highlight=true]:ring-2 data-[highlight=true]:ring-ring/60">
                    <Button
                        variant="outline"
                        size="sm"
                        className="w-fit"
                        aria-describedby="about-tour-hint"
                        onClick={() => {
                            useShellPrefs.getState().set({ onboarded: false });
                            useUiStore.getState().setSettingsOpen(false);
                        }}
                    >
                        <Sparkles aria-hidden /> {t("pack.tourAgain")}
                    </Button>
                    <p id="about-tour-hint" className="text-xs text-muted-foreground">
                        {t("pack.tourAgainHint")}
                    </p>
                </div>
            </Section>
            <Section title={t("settings.aboutUpdates")} settingId="about.updates">
                <p className="text-xs text-muted-foreground">{t("settings.aboutUpdatesHint")}</p>
                <div>
                    <Tooltip>
                        {/* Disabled buttons get no pointer events: the wrapper carries the tooltip. */}
                        <TooltipTrigger render={<span tabIndex={0} className="inline-flex rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/40" aria-describedby="about-updates-hint" />}>
                            <Button variant="outline" size="sm" disabled>
                                <RefreshCw aria-hidden /> {t("settings.aboutCheck")}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("settings.aboutUpdatesHint")}</TooltipContent>
                    </Tooltip>
                    <span id="about-updates-hint" className="sr-only">
                        {t("settings.aboutUpdatesHint")}
                    </span>
                </div>
            </Section>
        </div>
    );
}
