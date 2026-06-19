/**
 * Cloud profile sync — the engine behind MIXAI's "your setup, on any device"
 * promise.
 *
 * The user's whole profile (theme + custom themes, deck layout, companion
 * connection, MIDI + HID mappings, keyboard shortcuts and installed plugins)
 * is serialized by {@link buildProfileJson} and stored as one opaque blob in
 * the muzicai.ro account (via the companion's `/mixai-profile` route).
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
 */

import { engine } from "@/bridge/engine";
import { useUiStore } from "@/state/ui-store";
import { useCompanionStore } from "@/state/companion-store";
import { useHidStore } from "@/state/hid-store";
import { useKeybindStore } from "@/state/keybind-store";
import { usePluginStore } from "@/plugins/plugin-store";
import { exportProfile, importProfile } from "@/lib/profile";

/** Serialize the live app state into a portable profile JSON string. */
export async function buildProfileJson(): Promise<string> {
    const ui = useUiStore.getState();
    const comp = useCompanionStore.getState();
    const midiPreset = await engine.midiGetPreset();
    return exportProfile({
        theme: ui.theme,
        deckCount: ui.deckCount,
        customThemes: ui.customThemes,
        companion: {
            baseUrl: comp.baseUrl,
            deviceToken: comp.deviceToken,
            userId: comp.userId,
        },
        midiPreset: midiPreset ?? null,
        hidPreset: useHidStore.getState().preset,
        externalPlugins: usePluginStore.getState().externalSpecs,
        keybinds: useKeybindStore.getState().overrides,
    });
}

/**
 * Apply a profile backup string to the live app. Returns false when the blob
 * is unparseable. Individual missing sections are simply skipped.
 *
 * NOTE: the companion connection (`companion`) is intentionally NOT applied
 * here — auto-sync runs *because* we are already connected, and overwriting the
 * device token with a stale one from another machine could break the link. The
 * manual "Load from cloud" path (in SettingsPanel) still restores it.
 */
export async function applyProfileJson(
    raw: string,
    opts: { includeCompanion?: boolean } = {},
): Promise<boolean> {
    const parsed = importProfile(raw.trim());
    if (!parsed) return false;
    useUiStore.getState().restoreProfile({
        theme: parsed.theme as never,
        deckCount: parsed.deckCount,
        customThemes: parsed.customThemes,
    });
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
    return true;
}

/** True when the companion is configured enough to reach the cloud. */
function signedIn(): boolean {
    const c = useCompanionStore.getState();
    return Boolean(c.deviceToken && c.userId);
}

const PUSH_DEBOUNCE_MS = 4000;

/**
 * Start automatic cloud sync. Returns a cleanup function that stops it.
 *
 * Lifecycle:
 *   1. If signed in, pull the cloud profile once and apply it (skipping the
 *      companion section). While applying, pushes are suppressed so the
 *      incoming snapshot doesn't immediately bounce back.
 *   2. Subscribe to every profile-bearing store. Any change schedules a
 *      debounced push of the full profile. Sign-in transitions also trigger an
 *      initial pull-then-push.
 */
export function startCloudAutoSync(): () => void {
    let disposed = false;
    let suppressUntil = 0; // ignore changes while applying a pulled profile
    let pushTimer: ReturnType<typeof setTimeout> | null = null;
    let wasSignedIn = false;
    let pulledForSession = false;

    const schedulePush = () => {
        if (disposed || !signedIn()) return;
        if (Date.now() < suppressUntil) return;
        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = setTimeout(() => {
            pushTimer = null;
            void (async () => {
                if (disposed || !signedIn()) return;
                try {
                    const json = await buildProfileJson();
                    await engine.companionPutProfile(json);
                } catch {
                    // Offline / companion down — auto-sync is best-effort. The
                    // next local change (or manual save) will retry.
                }
            })();
        }, PUSH_DEBOUNCE_MS);
    };

    const pull = async () => {
        if (disposed || !signedIn() || pulledForSession) return;
        pulledForSession = true;
        try {
            const json = await engine.companionGetProfile();
            if (!json) return; // nothing stored yet
            // Suppress change-driven pushes during/just-after apply so the
            // freshly-pulled state isn't immediately re-uploaded.
            suppressUntil = Date.now() + PUSH_DEBOUNCE_MS;
            await applyProfileJson(json);
            suppressUntil = Date.now() + 1500;
        } catch {
            pulledForSession = false; // allow a later retry on next sign-in
        }
    };

    // 1) Initial pull (microtask so callers can finish mounting first).
    void pull();

    // 2) Subscriptions. Companion sign-in transitions drive a pull; everything
    //    else just schedules a push.
    const unsubs: Array<() => void> = [];

    unsubs.push(
        useCompanionStore.subscribe(() => {
            const now = signedIn();
            if (now && !wasSignedIn) {
                pulledForSession = false;
                void pull();
            }
            wasSignedIn = now;
            schedulePush();
        }),
    );
    wasSignedIn = signedIn();

    unsubs.push(useUiStore.subscribe(schedulePush));
    unsubs.push(useHidStore.subscribe(schedulePush));
    unsubs.push(useKeybindStore.subscribe(schedulePush));
    unsubs.push(usePluginStore.subscribe(schedulePush));

    return () => {
        disposed = true;
        if (pushTimer) clearTimeout(pushTimer);
        for (const u of unsubs) u();
    };
}
