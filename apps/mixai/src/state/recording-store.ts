/**
 * Master-mix recording state, shared by the title bar REC button and the command
 * palette so both surfaces toggle the same session.
 */
import { create } from "zustand";
import { engine } from "@/bridge/engine";

interface RecordingStore {
    recording: boolean;
    busy: boolean;
    startedAt: number;
    /** Path of the WAV being written (the one picked in the save dialog); null while not recording. */
    path: string | null;
    toggle: () => Promise<void>;
}

export const useRecordingStore = create<RecordingStore>((set, get) => ({
    recording: false,
    busy: false,
    startedAt: 0,
    path: null,
    toggle: async () => {
        if (get().busy) return;
        set({ busy: true });
        try {
            if (get().recording) {
                await engine.stopRecording();
                set({ recording: false, startedAt: 0, path: null });
            } else {
                const path = await engine.startRecording();
                if (path) set({ recording: true, startedAt: Date.now(), path });
            }
        } finally {
            set({ busy: false });
        }
    },
}));
