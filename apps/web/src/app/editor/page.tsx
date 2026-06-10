import { SoundEditorPage } from "@/components/editor/sound-editor-page";
import { RemoteHostBridge } from "@/components/remote/remote-host-bridge";
import { DAWProvider } from "@/components/daw/daw-context";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function EditorRoute() {
    const session = await auth();
    if (!session?.user?.id) redirect("/login?from=/editor");
    return (
        <RemoteHostBridge page="editor">
            <DAWProvider>
                <SoundEditorPage />
            </DAWProvider>
        </RemoteHostBridge>
    );
}
