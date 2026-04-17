"use client";

import { RemoteProvider } from "@/components/remote/remote-context";
import { RemoteController } from "@/components/remote/remote-controller";

export default function RemotePage() {
    return (
        <RemoteProvider page="idle">
            <RemoteController />
        </RemoteProvider>
    );
}
