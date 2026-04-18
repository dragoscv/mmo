import { DAWProvider } from "@/components/daw/daw-context";
import { DAWPage } from "@/components/daw/daw-page";
import { MidiProvider } from "@/hooks/use-midi";
import { RemoteHostBridge } from "@/components/remote/remote-host-bridge";
import { DAWRemoteBridge } from "@/components/remote/daw-remote-bridge";

export const dynamic = "force-dynamic";

export default function DAWRoute() {
    return (
        <RemoteHostBridge page="daw">
            <MidiProvider>
                <DAWProvider>
                    <DAWRemoteBridge />
                    <DAWPage />
                </DAWProvider>
            </MidiProvider>
        </RemoteHostBridge>
    );
}
