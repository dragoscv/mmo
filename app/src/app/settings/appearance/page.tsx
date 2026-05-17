import { getLocale } from "next-intl/server";
import { LocaleSwitcher } from "@/components/settings/locale-switcher";
import type { AppLocale } from "@/i18n/locales";

export const dynamic = "force-dynamic";

export default async function AppearanceSettingsPage() {
    const locale = (await getLocale()) as AppLocale;
    return (
        <main className="p-4 sm:p-6 max-w-3xl space-y-6">
            <header>
                <h1 className="text-2xl font-bold">Aspect &amp; limbă</h1>
                <p className="text-sm text-muted-foreground">Temă, limbă, densitate.</p>
            </header>
            <LocaleSwitcher current={locale} />
        </main>
    );
}
