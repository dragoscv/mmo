/**
 * Cloud profile sync — the engine behind MIXAI's "your setup, on any device"
 * promise.
 *
 * The user's whole profile (appearance prefs, deck layout, companion
 * connection, MIDI + HID mappings, keyboard shortcuts and installed plugins)
 * is serialized by {@link buildProfileJson} and stored as one opaque blob in
 * the mixai.ro account (via the companion's `/mixai-profile` route).
 *
 * Two paths use it:
 *   - Manual: the Settings → Profile "Save/Load to cloud" buttons.
 *   - Automatic ({@link startCloudAutoSync}): on launch, when signed in, we
 *     pull the cloud profile and apply it; thereafter any local change is
 *     debounce-pushed back so the account always reflects the latest setup.
 *
 * Auto-sync is intentionally last-write-wins on a single blob — simple and
 * predictable for a single-user-many-devices model. A real merge/marketplace
 * backend is a later milestone.
 *
 * The automatic path itself (order of pull and push, what the gig lock holds back and what
 * wins afterwards) is `createCloudSync` in gig/held-sync.ts; this file gives it the engine,
 * the stores and the gig gate.
 */

import { engine } from "@/bridge/engine";
import { useUiStore } from "@/state/ui-store";
import { useCompanionStore } from "@/state/companion-store";
import { useHidStore } from "@/state/hid-store";
import { useKeybindStore } from "@/state/keybind-store";
import { usePluginStore } from "@/plugins/plugin-store";
import { exportProfile, importProfile } from "@/lib/profile";
import { useLayoutStore } from "@/layout/layout-store";
import { useProfilesStore } from "@/settings/profiles-store";
import { createCloudSync, type ApplyResult, type KeyValue } from "@/gig/held-sync";
import { gigAllows, useGigStore } from "@/gig/gig-store";
import { PREFS_CHANGED_EVENT, applyPrefs, emitPrefsChanged, loadPrefs, savePrefs } from "@mmo/ui/theme";

/** Serialize the live app state into a portable profile JSON string. */
export async function buildProfileJson(): Promise<string> {
    const ui = useUiStore.getState();
    const comp = useCompanionStore.getState();
    const midiPreset = await engine.midiGetPreset();
    return exportProfile({
        prefs: loadPrefs(),
        deckCount: ui.deckCount,
        companion: {
            baseUrl: comp.baseUrl,
            deviceToken: comp.deviceToken,
            userId: comp.userId,
        },
        midiPreset: midiPreset ?? null,
        hidPreset: useHidStore.getState().preset,
        externalPlugins: usePluginStore.getState().externalSpecs,
        keybinds: useKeybindStore.getState().overrides,
        layout: useLayoutStore.getState().snapshot(),
        settingsProfiles: useProfilesStore.getState().snapshot(),
    });
}

/**
 * Apply a profile backup string to the live app and say what happened: "unreadable" when the
 * blob is not a profile, "locked" while the gig lock is on (nothing is applied). Individual
 * missing sections are simply skipped.
 *
 * NOTE: the companion connection (`companion`) is intentionally NOT applied
 * here — auto-sync runs *because* we are already connected, and overwriting the
 * device token with a stale one from another machine could break the link. The
 * manual "Load from cloud" path (in SettingsPanel) still restores it.
 */
export async function applyProfile(raw: string, opts: { includeCompanion?: boolean } = {}): Promise<ApplyResult> {
    if (!gigAllows("applySettings")) return "locked";
    const parsed = importProfile(raw.trim());
    if (!parsed) return "unreadable";
    useUiStore.getState().restoreProfile({ deckCount: parsed.deckCount });
    if (parsed.prefs) {
        // Persist + apply + notify the ThemeProvider (it listens for this event).
        savePrefs(parsed.prefs);
        applyPrefs(parsed.prefs);
        emitPrefsChanged(parsed.prefs);
    }
    if (opts.includeCompanion && parsed.companion) {
        useCompanionStore.getState().update(parsed.companion);
    }
    if (parsed.midiPreset) await engine.midiSetPreset(parsed.midiPreset);
    if (parsed.hidPreset) useHidStore.getState().setPreset(parsed.hidPreset);
    if (parsed.externalPlugins) {
        for (const spec of parsed.externalPlugins) {
            usePluginStore.getState().installExternal(JSON.stringify(spec));
        }
    }
    if (parsed.keybinds) useKeybindStore.getState().setOverrides(parsed.keybinds);
    if (parsed.layout) useLayoutStore.getState().restore(parsed.layout);
    if (parsed.settingsProfiles) useProfilesStore.getState().restore(parsed.settingsProfiles);
    return "applied";
}

/** {@link applyProfile} as a yes / no: false when the blob is unparseable or the gig lock is on. */
export async function applyProfileJson(
    raw: string,
    opts: { includeCompanion?: boolean } = {},
): Promise<boolean> {
    return (await applyProfile(raw, opts)) === "applied";
}

/**
 * Apply only the part of a profile that lives nowhere on this computer: the MIDI mapping (it
 * is kept by the engine, so after an app restart the engine holds the default one). Used when
 * the local profile wins over the account copy (gig/held-sync.ts), so that the upload does
 * not replace the account's mapping with the default.
 */
export async function applyProfileEngineOnly(raw: string): Promise<ApplyResult> {
    if (!gigAllows("applySettings")) return "locked";
    const parsed = importProfile(raw.trim());
    if (!parsed) return "unreadable";
    if (parsed.midiPreset) await engine.midiSetPreset(parsed.midiPreset);
    return "applied";
}

/** True when the companion is configured enough to reach the cloud. */
function signedIn(): boolean {
    const c = useCompanionStore.getState();
    return Boolean(c.deviceToken && c.userId);
}

function storageOf(pick: () => Storage): KeyValue | null {
    try {
        return pick();
    } catch {
        return null;
    }
}

/**
 * Start automatic cloud sync. Returns a cleanup function that stops it.
 *
 * Lifecycle (the machine is gig/held-sync.ts, where the rules are written down and tested):
 *   1. If signed in, pull the cloud profile once and apply it (skipping the
 *      companion section). While applying, pushes are suppressed so the
 *      incoming snapshot doesn't immediately bounce back.
 *   2. Subscribe to every profile-bearing store. Any change schedules a
 *      debounced push of the full profile. Sign-in transitions also trigger an
 *      initial pull-then-push.
 *
 * Gig lock (gig/gig-store): while it is on, no pull is made or applied and no push goes out.
 * A local change the lock kept from being uploaded is owed to the account: it is written down
 * and wins over the account's older copy at the unlock or at the next start.
 */
export function startCloudAutoSync(): () => void {
    let wasSignedIn = false;

    const sync = createCloudSync({
        signedIn,
        account: () => useCompanionStore.getState().userId,
        allowsPull: () => gigAllows("cloudPull"),
        allowsPush: () => gigAllows("cloudPush"),
        getProfile: () => engine.companionGetProfile(),
        putProfile: (json) => engine.companionPutProfile(json),
        build: buildProfileJson,
        apply: (json) => applyProfile(json),
        applyEngineOnly: applyProfileEngineOnly,
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        local: storageOf(() => localStorage),
        session: storageOf(() => sessionStorage),
    });

    // 1) Initial pull (microtask so callers can finish mounting first).
    void sync.pull();

    // 2) Subscriptions. Companion sign-in transitions drive a pull; everything
    //    else just schedules a push.
    const unsubs: Array<() => void> = [];

    unsubs.push(
        useCompanionStore.subscribe(() => {
            const now = signedIn();
            if (now && !wasSignedIn) void sync.signedIn();
            wasSignedIn = now;
            sync.changed();
        }),
    );
    wasSignedIn = signedIn();

    unsubs.push(useUiStore.subscribe(sync.changed));
    unsubs.push(useHidStore.subscribe(sync.changed));
    unsubs.push(useKeybindStore.subscribe(sync.changed));
    unsubs.push(usePluginStore.subscribe(sync.changed));
    unsubs.push(useLayoutStore.subscribe(sync.changed));
    unsubs.push(useProfilesStore.subscribe(sync.changed));
    // Appearance prefs live outside zustand (shared ThemeProvider store).
    window.addEventListener(PREFS_CHANGED_EVENT, sync.changed);
    unsubs.push(() => window.removeEventListener(PREFS_CHANGED_EVENT, sync.changed));

    // Gig lock. Going on: a push that was waiting for its 4 s is decided at once (owed or
    // not). Released: `prev.skipped` still says what was held (the store clears it on unlock).
    unsubs.push(
        useGigStore.subscribe((s, prev) => {
            if (!prev.locked && s.locked) void sync.lockedNow();
            if (prev.locked && !s.locked) void sync.released({ pull: prev.skipped.cloudPull, push: prev.skipped.cloudPush });
        }),
    );

    return () => {
        sync.dispose();
        for (const u of unsubs) u();
    };
}
