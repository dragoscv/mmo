import { getSettings } from "@/actions/settings";
import { SettingsClient } from "./settings-client";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
    const settings = await getSettings();

    return (
        <div className="flex flex-col h-full">
            <div className="shrink-0 sticky top-0 z-20 bg-background/95 backdrop-blur-sm px-3 sm:px-4 md:px-6 pt-3 sm:pt-4 md:pt-6 pb-3 border-b border-border">
                <h1 className="text-3xl font-bold">Settings</h1>
                <p className="text-[var(--muted-foreground)]">
                    Configurare aplicație
                </p>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-4 md:px-6 py-4 sm:py-5 md:py-6">
                <SettingsClient settings={settings} />
            </div>
        </div>
    );
}
