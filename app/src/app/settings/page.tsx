import { getSettings } from "@/actions/settings";
import { listAiKeys } from "@/actions/ai-keys";
import { getPreferredAiProvider } from "@/actions/ai-tag";
import { getLocale } from "next-intl/server";
import { auth } from "@/auth";
import { getSubscription } from "@/lib/stripe";
import { SettingsClient } from "./settings-client";
import { LocaleSwitcher } from "@/components/settings/locale-switcher";
import { BillingPanel } from "@/components/settings/billing-panel";
import { AiKeysPanel } from "@/components/settings/ai-keys-panel";
import { AccountPanel } from "@/components/settings/account-panel";
import type { AppLocale } from "@/i18n/locales";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
    const settings = await getSettings();
    const locale = (await getLocale()) as AppLocale;
    const session = await auth();
    const sub = session?.user?.id ? await getSubscription(session.user.id) : null;
    const aiKeys = session?.user?.id ? await listAiKeys() : [];
    const preferredAiProvider = session?.user?.id ? await getPreferredAiProvider() : null;

    return (
        <div className="flex flex-col h-full">
            <div className="shrink-0 sticky top-0 z-20 bg-background/95 backdrop-blur-sm px-3 sm:px-4 md:px-6 pt-3 sm:pt-4 md:pt-6 pb-3 border-b border-border">
                <h1 className="text-3xl font-bold">Settings</h1>
                <p className="text-[var(--muted-foreground)]">
                    Configurare aplicație
                </p>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-4 md:px-6 py-4 sm:py-5 md:py-6 space-y-6">
                <LocaleSwitcher current={locale} />
                {sub && (
                    <BillingPanel
                        plan={sub.plan}
                        isPro={sub.isPro}
                        status={sub.status}
                        currentPeriodEnd={sub.currentPeriodEnd}
                        cancelAtPeriodEnd={sub.cancelAtPeriodEnd}
                    />
                )}
                {session?.user?.id && <AiKeysPanel keys={aiKeys} preferredProvider={preferredAiProvider} />}
                <SettingsClient settings={settings} />
                {session?.user?.id && <AccountPanel />}
            </div>
        </div>
    );
}
