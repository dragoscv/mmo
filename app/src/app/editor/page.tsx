import { SoundEditorPage } from "@/components/editor/sound-editor-page";
import { RemoteHostBridge } from "@/components/remote/remote-host-bridge";

export const dynamic = "force-dynamic";

export default function EditorRoute() {
    return (
        <RemoteHostBridge page="editor">
            <SoundEditorPage />
        </RemoteHostBridge>
    );
}
