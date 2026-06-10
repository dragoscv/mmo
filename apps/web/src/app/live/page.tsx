import { LiveProvider } from "@/components/live/live-context";
import { LivePage } from "@/components/live/live-page";
import { RemoteHostBridge } from "@/components/remote/remote-host-bridge";
import { LiveRemoteBridge } from "@/components/remote/live-remote-bridge";
import { CompanionOfflineBanner } from "@/components/companion/companion-offline-banner";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LiveRoute() {
    const session = await auth();
    if (!session?.user?.id) redirect("/login?from=/live");
    return (
        <RemoteHostBridge page="live">
            <LiveProvider>
                <LiveRemoteBridge />
                <CompanionOfflineBanner context="live" />
                <LivePage />
            </LiveProvider>
        </RemoteHostBridge>
    );
}
