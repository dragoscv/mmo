"use server";

import { eq, inArray } from "drizzle-orm";
import { auth, signOut } from "@/auth";
import { db } from "@/db";
import {
    users,
    accounts,
    sessions,
    userPreferences,
    userProfiles,
    profilePreferences,
    devices,
    deviceFolders,
    recordings,
    tracks,
    playlists,
    playlistTracks,
    tags,
    trackTags,
    cuepoints,
    subscriptions,
    pushSubscriptions,
    smartPlaylistRules,
    savedSearches,
} from "@/db/schema";
import { log } from "@/lib/logger";

/**
 * GDPR-style "export everything I have on you" snapshot. Returns a JSON
 * blob containing every per-user row across the schema. Sensitive fields
 * are explicitly redacted: OAuth refresh/access tokens (in `accounts`),
 * device tokens (in `devices`), and encrypted AI provider keys (in
 * `userPreferences`) — these are credentials, not data the user owns,
 * and shipping them in a downloadable file would defeat the encryption.
 *
 * The dump deliberately includes `tracks.audioFingerprint` because that's
 * derived from the user's own audio file and they have a right to take
 * it elsewhere (e.g. seed another deduplication tool).
 */
export async function exportUserData(): Promise<{
    ok: true;
    data: UserDataExport;
} | { ok: false; error: string }> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { ok: false, error: "unauthenticated" };

    try {
        // First fetch the per-user-rooted tables; the others are joined by
        // their parent ids below.
        const [
            user,
            userAccounts,
            userSessions,
            prefs,
            profiles,
            userDevices,
            userRecordings,
            userTracks,
            userPlaylists,
            userTags,
            sub,
            push,
            smartRules,
            saved,
        ] = await Promise.all([
            db.select().from(users).where(eq(users.id, userId)).limit(1),
            db.select().from(accounts).where(eq(accounts.userId, userId)),
            db.select().from(sessions).where(eq(sessions.userId, userId)),
            db.select().from(userPreferences).where(eq(userPreferences.userId, userId)),
            db.select().from(userProfiles).where(eq(userProfiles.userId, userId)),
            db.select().from(devices).where(eq(devices.userId, userId)),
            db.select().from(recordings).where(eq(recordings.userId, userId)),
            db.select().from(tracks).where(eq(tracks.userId, userId)),
            db.select().from(playlists).where(eq(playlists.userId, userId)),
            db.select().from(tags).where(eq(tags.userId, userId)),
            db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1),
            db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)),
            db.select().from(smartPlaylistRules).where(eq(smartPlaylistRules.userId, userId)),
            db.select().from(savedSearches).where(eq(savedSearches.userId, userId)),
        ]);

        // Now fetch tables joined by parent id. inArray with an empty list
        // is a no-op in Drizzle (returns []), so we don't need to guard.
        const profileIds = profiles.map((p) => p.id);
        const trackIds = userTracks.map((t) => t.id);
        const playlistIds = userPlaylists.map((p) => p.id);
        const deviceIds = userDevices.map((d) => d.id);
        const tagIds = userTags.map((t) => t.id);

        const [
            profilePrefs,
            userDeviceFolders,
            userPlaylistTracks,
            userTrackTags,
            userCuepoints,
        ] = await Promise.all([
            profileIds.length
                ? db.select().from(profilePreferences).where(inArray(profilePreferences.profileId, profileIds))
                : Promise.resolve([]),
            deviceIds.length
                ? db.select().from(deviceFolders).where(inArray(deviceFolders.deviceId, deviceIds))
                : Promise.resolve([]),
            playlistIds.length
                ? db.select().from(playlistTracks).where(inArray(playlistTracks.playlistId, playlistIds))
                : Promise.resolve([]),
            tagIds.length && trackIds.length
                ? db.select().from(trackTags).where(inArray(trackTags.tagId, tagIds))
                : Promise.resolve([]),
            trackIds.length
                ? db.select().from(cuepoints).where(inArray(cuepoints.trackId, trackIds))
                : Promise.resolve([]),
        ]);

        const data: UserDataExport = {
            exportedAt: new Date().toISOString(),
            schemaVersion: 1,
            user: user[0]
                ? { id: user[0].id, name: user[0].name, email: user[0].email, image: user[0].image }
                : null,
            accounts: userAccounts.map((a) => ({
                provider: a.provider,
                providerAccountId: a.providerAccountId,
                type: a.type,
                // refresh_token, access_token, id_token redacted by design
            })),
            sessions: userSessions.map((s) => ({ expires: s.expires })),
            preferences: prefs.map((p) => {
                // userPreferences may store encrypted AI keys keyed by provider;
                // strip any field whose name hints at credentials.
                const safe: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(p)) {
                    if (/key|secret|token/i.test(k)) continue;
                    safe[k] = v;
                }
                return safe;
            }),
            profiles,
            profilePreferences: profilePrefs,
            devices: userDevices.map((d) => {
                const { ...rest } = d as Record<string, unknown>;
                // device tokens (plaintext column was dropped in 0007;
                // any *_at_rest column is encrypted but still a credential)
                delete rest.tokenAtRest;
                delete rest.token;
                return rest;
            }),
            deviceFolders: userDeviceFolders,
            recordings: userRecordings,
            tracks: userTracks,
            playlists: userPlaylists,
            playlistTracks: userPlaylistTracks,
            tags: userTags,
            trackTags: userTrackTags,
            cuepoints: userCuepoints,
            subscription: sub[0]
                ? {
                    plan: sub[0].plan,
                    status: sub[0].status,
                    currentPeriodEnd: sub[0].currentPeriodEnd,
                    cancelAtPeriodEnd: sub[0].cancelAtPeriodEnd,
                    // stripeCustomerId, stripeSubscriptionId redacted
                }
                : null,
            pushSubscriptions: push.map((p) => ({
                endpoint: p.endpoint,
                createdAt: p.createdAt,
                // p256dh / auth keys redacted (they're crypto secrets the
                // browser holds; re-issuing them is harmless on next sub)
            })),
            smartPlaylistRules: smartRules,
            savedSearches: saved,
        };
        log.info("[account] data export", { userId, tracks: userTracks.length });
        return { ok: true, data };
    } catch (e) {
        log.error("[account] export failed", { userId, error: String(e) });
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * Fully delete the signed-in user. The schema cascades from `users.id`
 * down through every per-user table, so the only manual cleanup is the
 * Stripe customer (a remote object). The Stripe call is best-effort:
 * if it fails the local row deletion still goes through, because
 * leaving a tenant in our DB after they pressed "Delete" would be the
 * worse failure mode.
 *
 * Requires a typed-string confirmation to defeat accidental clicks.
 */
export async function deleteAccount(confirmation: string): Promise<
    { ok: true } | { ok: false; error: string }
> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { ok: false, error: "unauthenticated" };
    if (confirmation !== "DELETE") {
        return { ok: false, error: "confirmation phrase mismatch" };
    }

    // Best-effort: cancel the Stripe customer so we don't leave a
    // dangling subscription billing the user after they're gone.
    try {
        const sub = await db
            .select({ customer: subscriptions.stripeCustomerId })
            .from(subscriptions)
            .where(eq(subscriptions.userId, userId))
            .limit(1);
        if (sub[0]?.customer) {
            const { stripe } = await import("@/lib/stripe");
            await stripe().customers.del(sub[0].customer);
        }
    } catch (e) {
        // Don't block the local delete on a Stripe outage.
        log.warn("[account] stripe customer delete failed", {
            userId,
            error: String(e),
        });
    }

    try {
        await db.delete(users).where(eq(users.id, userId));
    } catch (e) {
        log.error("[account] user delete failed", { userId, error: String(e) });
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    log.info("[account] account deleted", { userId });
    // Sign out invalidates the session cookie. We don't redirect from a
    // server action — the client side will reload to / on its own.
    await signOut({ redirect: false });
    return { ok: true };
}

export interface UserDataExport {
    exportedAt: string;
    schemaVersion: number;
    user: { id: string; name: string | null; email: string | null; image: string | null } | null;
    accounts: { provider: string; providerAccountId: string; type: string }[];
    sessions: { expires: Date | string }[];
    preferences: Record<string, unknown>[];
    profiles: unknown[];
    profilePreferences: unknown[];
    devices: Record<string, unknown>[];
    deviceFolders: unknown[];
    recordings: unknown[];
    tracks: unknown[];
    playlists: unknown[];
    playlistTracks: unknown[];
    tags: unknown[];
    trackTags: unknown[];
    cuepoints: unknown[];
    subscription: {
        plan: string;
        status: string;
        currentPeriodEnd: Date | string | null;
        cancelAtPeriodEnd: boolean | null;
    } | null;
    pushSubscriptions: { endpoint: string; createdAt: Date | string | null }[];
    smartPlaylistRules: unknown[];
    savedSearches: unknown[];
}
