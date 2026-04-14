import { getSettings } from "@/actions/settings";
import { ScannerClient } from "./scanner-client";

export const dynamic = "force-dynamic";

export default async function ScannerPage() {
  const settings = await getSettings();
  const watchFolders = settings.watch_folders
    ? JSON.parse(settings.watch_folders)
    : [];
  const musicRoot = settings.music_root || "H:\\Music";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Scanner</h1>
        <p className="text-[var(--muted-foreground)]">
          Scanează foldere pentru a adăuga melodii în bibliotecă
        </p>
      </div>

      <ScannerClient watchFolders={watchFolders} musicRoot={musicRoot} />
    </div>
  );
}
