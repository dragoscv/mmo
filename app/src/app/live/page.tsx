import { LiveProvider } from "@/components/live/live-context";
import { LivePage } from "@/components/live/live-page";
import { RemoteHostBridge } from "@/components/remote/remote-host-bridge";
import { LiveRemoteBridge } from "@/components/remote/live-remote-bridge";

export const dynamic = "force-dynamic";

export default function LiveRoute() {
    return (
        <RemoteHostBridge page="live">
            <LiveProvider>
                <LiveRemoteBridge />
                <LivePage />
            </LiveProvider>
        </RemoteHostBridge>
    );
}
