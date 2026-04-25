import { SoundEditorPage } from "@/components/editor/sound-editor-page";
import { RemoteHostBridge } from "@/components/remote/remote-host-bridge";
import { DAWProvider } from "@/components/daw/daw-context";

export const dynamic = "force-dynamic";

export default function EditorRoute() {
    return (
        <RemoteHostBridge page="editor">
            <DAWProvider>
                <SoundEditorPage />
            </DAWProvider>
        </RemoteHostBridge>
    );
}
