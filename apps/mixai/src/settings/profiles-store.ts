/**
 * Settings profiles store (`mixai-settings-profiles` in localStorage).
 * Switching applies the profile's sections without the diff dialog but
 * through the undo store, so "Undo" brings the previous setup back.
 */
import { create } from "zustand";
import {
    PROFILES_KEY,
    isSeed,
    normalizeProfiles,
    removeProfile,
    stripSensitive,
    uniqueProfileId,
    upsertProfile,
    type ProfilesState,
    type SettingsProfile,
} from "./profiles-core";
import { applySections, collect, type ApplyOutcome } from "./settings-live";
import { useUndoStore } from "./undo-store";

function load(): ProfilesState {
    try {
        return normalizeProfiles(JSON.parse(localStorage.getItem(PROFILES_KEY) ?? "null"));
    } catch {
        return normalizeProfiles(null);
    }
}

function save(s: ProfilesState): void {
    try {
        localStorage.setItem(PROFILES_KEY, JSON.stringify(s));
    } catch {
        // storage unavailable: non-fatal
    }
}

interface ProfilesStore extends ProfilesState {
    get: (id: string) => SettingsProfile | undefined;
    /** Store the current live settings into a profile (and mark it active). */
    saveCurrent: (id: string) => Promise<void>;
    /** Apply a profile (undoable). Returns false when the profile is empty, or was not applied (the gig lock is on). */
    switchTo: (id: string, undoLabel: string) => Promise<boolean>;
    rename: (id: string, name: string) => void;
    remove: (id: string) => void;
    duplicate: (id: string, name: string) => string | null;
    /** Replace everything (cloud profile restore). */
    restore: (s: unknown) => void;
    snapshot: () => ProfilesState;
}

export const useProfilesStore = create<ProfilesStore>((set, get) => {
    const commit = (next: ProfilesState) => {
        set(next);
        save(next);
    };
    const state = (): ProfilesState => ({ active: get().active, profiles: get().profiles });
    return {
        ...load(),
        get: (id) => get().profiles.find((p) => p.id === id),
        saveCurrent: async (id) => {
            const p = get().get(id);
            if (!p) return;
            const data = stripSensitive(await collect());
            commit({ ...upsertProfile(state(), { ...p, data }), active: id });
        },
        switchTo: async (id, undoLabel) => {
            const p = get().get(id);
            if (!p || Object.keys(p.data).length === 0) return false;
            // The outcome of the write decides: a profile that was not applied (the gig lock
            // went on between the click and here) is not marked active.
            const done: { outcome: ApplyOutcome } = { outcome: "locked" };
            await useUndoStore.getState().run(undoLabel, async () => {
                done.outcome = await applySections(p.data);
            });
            if (done.outcome !== "applied") return false;
            commit({ ...state(), active: id });
            return true;
        },
        rename: (id, name) => {
            const p = get().get(id);
            const clean = name.trim().slice(0, 40);
            if (!p || !clean) return;
            commit(upsertProfile(state(), { ...p, name: clean }));
        },
        remove: (id) => {
            if (isSeed(id)) return;
            commit(removeProfile(state(), id));
        },
        duplicate: (id, name) => {
            const p = get().get(id);
            if (!p) return null;
            const newId = uniqueProfileId(state(), name);
            commit(upsertProfile(state(), { id: newId, name: name.slice(0, 40), icon: "user", data: p.data }));
            return newId;
        },
        restore: (s) => commit(normalizeProfiles(s)),
        snapshot: state,
    };
});
