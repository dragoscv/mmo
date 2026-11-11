/**
 * "Hand the music queue to a TV" — pure part (no React / DOM, so `send-to-tv.test.ts` runs in node).
 * UI: `send-to-tv-button.tsx`.
 *
 * ── Hub command (shared arg shape; keep in sync with the receivers) ───────────────────────────────────────
 * Devices that advertise the `music` cap accept
 *
 *   cmd "play" { trackIds: string[]   Subsonic track ids (`tr_<n>`), ≤ 2000, in play order
 *                index: number        position of the track to start with in `trackIds`
 *                positionSec: number  where to start inside that track
 *                shuffle: boolean     true = the receiver shuffles the list (start track stays first)
 *                repeat: "off" | "all" | "one" }
 *
 * and answer `ack {ok}` or `ack {ok:false, error}` (`tracks_not_found`, `trackIds_required`, …).
 * Receivers (all pre-existing, nothing new on the TVs): tv-tizen `src/App.tsx` `playMusic` +
 * `src/lib/music-remote.ts` `parseMusicPlayArgs`; tv-android `MainActivity.kt` `playMusicQueue`;
 * iOS `MusicAppModel.handle`. Other senders: tv-android `cast/Transports.kt` `HubTvTransport.load`, iOS
 * `MusicAppModel.handoff`. Documented on `/hub/command` in `server/openapi.yaml` (args are untyped JSON).
 * ───────────────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `PUT /media/music/queue` takes the same fields, so one build feeds both: the server copy keeps this
 * profile's queue current (next session / other devices restore it), the command starts the TV right away.
 */
import type { HubDevice, MusicQueueInput, RepeatMode, TrackCard } from "@/lib/mmo/media-types";

/** Hub action + cap of a music queue handoff. */
export const MUSIC_PLAY_ACTION = "play";
export const MUSIC_CAP = "music";

/** Devices that play a music queue: connected, not this browser, not a guest, advertising `music`. */
export function musicTargets(devices: readonly HubDevice[], selfId: string): HubDevice[] {
    return devices.filter((d) => d.deviceId !== selfId && !d.guest && Array.isArray(d.caps) && d.caps.includes(MUSIC_CAP));
}

export interface QueueHandoffInput {
    queue: readonly Pick<TrackCard, "id">[];
    index: number;
    positionSec: number;
    shuffle: boolean;
    repeat: RepeatMode;
}

export interface MusicPlayCommandArgs {
    trackIds: string[];
    index: number;
    positionSec: number;
    shuffle: boolean;
    repeat: RepeatMode;
}

export interface QueueHandoff {
    /** Body for `PUT /media/music/queue` (keeps the web shuffle flag, like the player's own save). */
    queue: MusicQueueInput;
    /** Args for hub `cmd play`. `shuffle` is always false: the list is already in play order (a shuffled web
     *  queue is stored shuffled), so the TV must keep it instead of shuffling again. */
    command: MusicPlayCommandArgs;
}

const SERVER_ID = /^tr_\d+$/;
const MAX_IDS = 2000;

/**
 * Queue → server body + command args: server track ids only (anything else cannot be fetched by a TV), at
 * most 2000, `index` re-pointed at the current track — or the next sendable one, then the position is
 * dropped. Null when no track can be sent.
 */
export function buildQueueHandoff(i: QueueHandoffInput): QueueHandoff | null {
    const ids: string[] = [];
    let index = -1;
    let exact = false;
    for (let k = 0; k < i.queue.length && ids.length < MAX_IDS; k++) {
        const id = i.queue[k]!.id;
        if (!SERVER_ID.test(id)) continue;
        if (index < 0 && k >= i.index) { index = ids.length; exact = k === i.index; }
        ids.push(id);
    }
    if (ids.length === 0) return null;
    if (index < 0) index = ids.length - 1;
    const positionSec = exact && Number.isFinite(i.positionSec) && i.positionSec > 0 ? Math.floor(i.positionSec) : 0;
    return {
        queue: { trackIds: ids, index, positionSec, shuffle: i.shuffle, repeat: i.repeat },
        command: { trackIds: ids, index, positionSec, shuffle: false, repeat: i.repeat },
    };
}

export type HandoffFailure = "empty" | "offline" | "timeout" | "not_found" | "rejected";
export type HandoffResult = { ok: true } | { ok: false; reason: HandoffFailure; detail?: string };

/** Hub ack → result. `offline` / `no_such_device` / `timeout` come from `HubClient.commandAwait`, the rest from the TV. */
export function handoffResult(ack: { ok?: boolean; error?: string } | null): HandoffResult {
    if (ack && ack.ok !== false) return { ok: true };
    const e = ack?.error;
    if (e === "timeout") return { ok: false, reason: "timeout" };
    if (e === "offline" || e === "no_such_device") return { ok: false, reason: "offline" };
    if (e === "tracks_not_found" || e === "no_tracks") return { ok: false, reason: "not_found" };
    return { ok: false, reason: "rejected", ...(e ? { detail: e } : {}) };
}

export interface HandoffDeps {
    /** `MusicClient.setQueue`. */
    saveQueue(q: MusicQueueInput): Promise<unknown>;
    /** `HubClient.commandAwait`. */
    command(deviceId: string, action: string, args: Record<string, unknown>): Promise<{ ok?: boolean; error?: string } | null>;
}

/**
 * One click: save the queue on the server, then tell the device to play it. The save is best effort — the
 * command carries everything the TV needs — so a failed save never blocks the handoff.
 */
export async function handQueueToDevice(deps: HandoffDeps, deviceId: string, input: QueueHandoffInput): Promise<HandoffResult> {
    const h = buildQueueHandoff(input);
    if (!h) return { ok: false, reason: "empty" };
    try { await deps.saveQueue(h.queue); } catch { /* the command below is enough to start the TV */ }
    let ack: { ok?: boolean; error?: string } | null;
    try {
        ack = await deps.command(deviceId, MUSIC_PLAY_ACTION, { ...h.command });
    } catch {
        return { ok: false, reason: "offline" };
    }
    return handoffResult(ack);
}
