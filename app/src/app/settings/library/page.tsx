import { getSettings } from "@/actions/settings";
import { SettingsClient } from "../settings-client";

export const dynamic = "force-dynamic";

export default async function LibrarySettingsPage() {
    const settings = await getSettings();
    return (
        <main className="p-4 sm:p-6">
            <header className="mb-4">
                <h1 className="text-2xl font-bold">Bibliotecă</h1>
                <p className="text-sm text-muted-foreground">Foldere music, watch folders, import Rekordbox, mod offline.</p>
            </header>
            <SettingsClient settings={settings} />
        </main>
    );
}
