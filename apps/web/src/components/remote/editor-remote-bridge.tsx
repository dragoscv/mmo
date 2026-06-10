"use client";

/**
 * EditorRemoteBridge — Drop this inside the Sound Editor page (within EditorProvider)
 * to start broadcasting state and handling remote commands.
 * Renders nothing.
 */

import { useRemoteEditorHost } from "./use-remote-editor-host";

export function EditorRemoteBridge() {
    useRemoteEditorHost();
    return null;
}
