/**
 * Development only (loaded by gig-runtime behind `import.meta.env.DEV`, so it is not part of a
 * production bundle): `window.__decksExt.gigDebug` lets a remote debugger exercise the gate
 * points of the gig lock through the app's own module instances (a module imported by URL from
 * the debugger can be a second instance after a hot reload). Every answer is a picked value,
 * never a whole store.
 */
import { devExpose } from "@/dev/expose";
import { applyProfileJson, buildProfileJson } from "@/lib/cloud-sync";
import { usePluginStore } from "@/plugins/plugin-store";
import { useSettingsSearchFocus } from "@/settings/hotkey";
import { useProfilesStore } from "@/settings/profiles-store";
import { applySections } from "@/settings/settings-live";
import type { Sections } from "@/settings/settings-io";

devExpose("gigDebug", {
    /** Raise a plugin notification the way `ctx.notify` does. */
    toast: (message: string) => usePluginStore.getState().pushToast(message),
    toasts: () => usePluginStore.getState().toasts.length,
    /** The shared write path of import / reset / profiles / undo. */
    applySections: (sections: Sections) => applySections(sections),
    /** Build the cloud profile from the live state and apply it again (a no-op change when allowed). */
    reapplyProfile: async () => {
        const json = await buildProfileJson();
        return { bytes: json.length, applied: await applyProfileJson(json) };
    },
    searchPending: () => useSettingsSearchFocus.getState().pending,
    profiles: () => ({ active: useProfilesStore.getState().active, count: useProfilesStore.getState().profiles.length }),
});
