import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { SoundEditorSettingsPanel } from "@/components/settings/sound-editor-settings-panel";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("nav");
    return { title: t("settings-editor") };
}

export default async function SoundEditorSettingsPage() {
    const t = await getTranslations("settings.sound-editor");
    return (
        <main className="space-y-6">
            <header>
                <h1 className="font-heading text-2xl font-semibold tracking-tight">{t("title")}</h1>
                <p className="text-sm text-muted-foreground">{t("description")}</p>
            </header>
            <SoundEditorSettingsPanel />
        </main>
    );
}
