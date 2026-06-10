import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { DevicesClient } from "./devices-client";
import { getDevices, getCachedCompanionFolders } from "@/actions/devices";
import { CompanionOfflineBanner } from "@/components/companion/companion-offline-banner";
import type { CompanionFolder } from "@/lib/companion-types";

export const dynamic = "force-dynamic";

export default async function DevicesPage() {
    const session = await auth();
    if (!session?.user) {
        redirect("/login");
    }

    const userDevices = await getDevices();
    // Hydrate the cached library folders for every device in parallel so
    // the first paint shows the full list without waiting for the
    // companion to come online or even respond. The client refreshes
    // from the live companion on mount and reconciles silently.
    const folderPairs = await Promise.all(
        userDevices.map(async (d) => [d.id, await getCachedCompanionFolders(d.id)] as const),
    );
    const initialFolders: Record<string, CompanionFolder[]> = Object.fromEntries(folderPairs);

    return (
        <div className="flex flex-col h-full">
            <div className="shrink-0 sticky top-0 z-20 bg-background/95 backdrop-blur-sm px-3 sm:px-4 md:px-6 pt-3 sm:pt-4 md:pt-6 pb-3 border-b border-border">
                <h1 className="text-3xl font-bold">Devices</h1>
                <p className="text-muted-foreground">
                    Manage companion servers and remote music libraries
                </p>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-4 md:px-6 py-4 sm:py-5 md:py-6">
                <CompanionOfflineBanner context="devices" />
                <DevicesClient initialDevices={userDevices} initialFolders={initialFolders} />
            </div>
        </div>
    );
}
