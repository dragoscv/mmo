import { ScannerClient } from "./scanner-client";
import { auth } from "@/auth";
import { getScannerOverview } from "@/actions/devices";
import { notSignedInFor, noCompanionFor } from "@/components/empty-state-server";

export const dynamic = "force-dynamic";

export default async function ScannerPage() {
    const session = await auth();
    if (!session?.user?.id) return notSignedInFor("scanner");

    const companions = await getScannerOverview();
    if (companions.length === 0) return noCompanionFor("scanner");

    return (
        <div className="flex flex-col h-full">
            <div className="shrink-0 sticky top-0 z-20 bg-background/95 backdrop-blur-sm px-3 sm:px-4 md:px-6 pt-3 sm:pt-4 md:pt-6 pb-3 border-b border-border">
                <h1 className="text-3xl font-bold">Scanner</h1>
                <p className="text-[var(--muted-foreground)]">
                    Scan your music folders on each connected companion. Files
                    are read on the companion machine and ingested into your library.
                </p>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-4 md:px-6 py-4 sm:py-5 md:py-6">
                <ScannerClient companions={companions} />
            </div>
        </div>
    );
}
