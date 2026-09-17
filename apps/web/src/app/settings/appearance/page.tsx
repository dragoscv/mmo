import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AppearanceClient } from "./appearance-client";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("nav");
    return { title: t("settings-appearance") };
}

export default async function AppearanceSettingsPage() {
    const t = await getTranslations("settings.appearance");
    return (
        <main className="space-y-6">
            <header className="flex flex-col gap-1">
                <h1 className="font-heading text-2xl font-semibold tracking-tight">{t("title")}</h1>
                <p className="text-sm text-muted-foreground">{t("description")}</p>
            </header>
            <AppearanceClient />
        </main>
    );
}
