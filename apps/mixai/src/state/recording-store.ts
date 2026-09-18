/**
 * Master-mix recording state, shared by the TopBar REC button and the command
 * palette so both surfaces toggle the same session.
 */
import { create } from "zustand";
import { engine } from "@/bridge/engine";

interface RecordingStore {
    recording: boolean;
    busy: boolean;
    startedAt: number;
    toggle: () => Promise<void>;
}

export const useRecordingStore = create<RecordingStore>((set, get) => ({
    recording: false,
    busy: false,
    startedAt: 0,
    toggle: async () => {
        if (get().busy) return;
        set({ busy: true });
        try {
            if (get().recording) {
                await engine.stopRecording();
                set({ recording: false, startedAt: 0 });
            } else {
                const path = await engine.startRecording();
                if (path) set({ recording: true, startedAt: Date.now() });
            }
        } finally {
            set({ busy: false });
        }
    },
}));
