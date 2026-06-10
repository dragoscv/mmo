import { DAWProvider } from "@/components/daw/daw-context";
import { DAWPage } from "@/components/daw/daw-page";
import { RemoteHostBridge } from "@/components/remote/remote-host-bridge";
import { DAWRemoteBridge } from "@/components/remote/daw-remote-bridge";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function DAWRoute() {
    const session = await auth();
    if (!session?.user?.id) redirect("/login?from=/daw");
    return (
        <RemoteHostBridge page="daw">
            <DAWProvider>
                <DAWRemoteBridge />
                <DAWPage />
            </DAWProvider>
        </RemoteHostBridge>
    );
}
