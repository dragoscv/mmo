import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { MixerSettingsPanel } from "@/components/settings/mixer-settings-panel";

// No `force-dynamic`: no per-user server data here — the panel reads its
// state client-side. Dynamic rendering still follows from the locale cookie.

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("nav");
    return { title: t("settings-mixer") };
}

export default async function MixerSettingsPage() {
    const t = await getTranslations("settings.mixer");
    return (
        <main className="space-y-6">
            <header>
                <h1 className="font-heading text-2xl font-semibold tracking-tight">{t("title")}</h1>
                <p className="text-sm text-muted-foreground">{t("description")}</p>
            </header>
            <MixerSettingsPanel />
        </main>
    );
}
