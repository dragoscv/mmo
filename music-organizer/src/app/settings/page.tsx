import { getSettings } from "@/actions/settings";
import { SettingsClient } from "./settings-client";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await getSettings();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-[var(--muted-foreground)]">
          Configurare aplicație
        </p>
      </div>

      <SettingsClient settings={settings} />
    </div>
  );
}
