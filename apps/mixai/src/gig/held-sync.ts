/**
 * The cloud profile auto-sync as a small machine with every outside call injected
 * (lib/cloud-sync.ts wires it to the engine, the stores and the gig gate; held-sync.test.ts
 * drives it with a stand-in account). It lives here because its rules are the gig lock's.
 *
 * WHAT WINS. The sync is last-write-wins on one blob. Without the lock a local change is
 * uploaded 4 s later, so "local" is the last write. While the lock is on nothing is uploaded.
 * When an upload is refused by the lock and the local profile REALLY differs from the one this
 * app last agreed on with the account (last upload, last applied pull, or what the app started
 * with), the upload is owed and the debt is written down:
 * `localStorage["mixai-cloud-push-held"]` = the account's user id. While that marker stands
 * (at the unlock, at the next start locked or not, at the next sign-in) a pulled profile is NOT
 * applied over the local state: the local profile is uploaded, then the marker is cleared. A
 * pull that was on its way when the lock went on is dropped the same way. The marker is
 * cleared only by a successful upload, or by a pull that really was applied (the debt has
 * nothing left to say then); the marker of another account is ignored. A refused upload that
 * changed nothing (a store moved, the profile did not: the command palette opened, a HID
 * report arrived) leaves no marker; it goes out at the unlock in the old order, after a held
 * pull and only when that pull changed nothing here.
 *
 * THE ONE PART THAT IS NOT LOCAL. The MIDI mapping lives in the engine and nowhere on disk:
 * after an app restart the engine holds the default mapping until a pulled profile is applied.
 * Uploading "local" then would overwrite the account's mapping with the default (the trap an
 * earlier attempt fell into, tracker WP19-55). So an owed upload in an app process whose
 * engine state was never made true (`sessionStorage["mixai-cloud-engine-ok"]` is not set: no
 * pull was applied and the account was not found empty since the app started) first takes
 * that one part from the account copy (`applyEngineOnly`), and uploads nothing while the
 * account cannot be reached. The session flag survives a page reload (the engine process does
 * too) and not an app restart. A storage that cannot be read counts as "not set".
 *
 * ORDER (as before the lock; tracker WP19-55 lists what is still weak): at start and at
 * sign-in the account copy is pulled once per session; a pulled profile suppresses
 * change-driven uploads while it is applied; uploads are debounced 4 s. The marker only
 * replaces "apply the pull" by "upload local" in that same slot. It adds no upload before a
 * pull in any other situation, and an unlocked app without a marker behaves exactly as before.
 */
import { pushAfterPull, releaseFirst, type PullOutcome } from "./gig-core.ts";

/** localStorage: an upload is owed to this account (value = its user id). Not a setting; never synced. */
export const PUSH_HELD_KEY = "mixai-cloud-push-held";
/** sessionStorage: the engine-only state (MIDI mapping) of this app process is the DJ's own. */
export const ENGINE_OK_KEY = "mixai-cloud-engine-ok";
export const PUSH_DEBOUNCE_MS = 4000;
/** While the lock is on nothing is uploaded: a change is only checked ("is an upload owed?"), this soon after it. */
export const HELD_NOTE_MS = 300;
/** Change-driven uploads stay suppressed this long after a pulled profile was applied. */
export const AFTER_APPLY_MS = 1500;

/** What applying a profile did: "locked" = refused by the gig lock, "unreadable" = not a profile. */
export type ApplyResult = "applied" | "locked" | "unreadable";

/** The few calls of Storage this module needs. Every call may throw (storage disabled). */
export interface KeyValue {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
}

export interface SyncDeps {
    /** The companion is configured enough to reach the account. */
    signedIn: () => boolean;
    /** The account the marker belongs to (the user id; "" = none). */
    account: () => string;
    /** The gig gate for a pull / an upload (it counts what it holds back). */
    allowsPull: () => boolean;
    allowsPush: () => boolean;
    getProfile: () => Promise<string | null>;
    putProfile: (json: string) => Promise<unknown>;
    /** The local profile as JSON. */
    build: () => Promise<string>;
    /** Apply a pulled profile to the app. */
    apply: (json: string) => Promise<ApplyResult>;
    /** Apply only the part that lives nowhere on this computer (the MIDI mapping). */
    applyEngineOnly: (json: string) => Promise<ApplyResult>;
    now: () => number;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (handle: unknown) => void;
    /** localStorage and sessionStorage (null = not available). */
    local: KeyValue | null;
    session: KeyValue | null;
}

export interface CloudSync {
    /** The pull of this session (start, sign-in). Resolves with what happened. */
    pull: () => Promise<PullOutcome>;
    /** A profile-bearing store changed: schedule a debounced upload. */
    changed: () => void;
    /** The account credentials appeared: pull for them. */
    signedIn: () => Promise<PullOutcome>;
    /** The gig lock went on: an upload that was waiting for its 4 s is decided now (owed or not). */
    lockedNow: () => Promise<void>;
    /** The gig lock was released: run what it held back, once. */
    released: (held: { pull: boolean; push: boolean }) => Promise<void>;
    /** An upload is owed to the current account. */
    owed: () => boolean;
    /** Resolves when the work that timers and callbacks have started is done (tests). */
    idle: () => Promise<void>;
    dispose: () => void;
}

export function createCloudSync(d: SyncDeps): CloudSync {
    let disposed = false;
    let suppressUntil = 0;
    let pushTimer: unknown = null;
    let pulledForSession = false;
    /** Uploads that succeeded: an account answer that was asked for before one of them is stale. */
    let uploads = 0;
    /** The local profile as it was when this app last agreed with the account, or started. */
    let synced: string | null = null;
    /** Everything started in the background (tests wait for it). */
    let busy: Promise<void> = Promise.resolve();
    /** Only the "is this upload owed?" checks (the unlock waits for these, never for the network). */
    let noting: Promise<void> = Promise.resolve();
    const settled = (p: Promise<unknown>): Promise<void> =>
        p.then(
            () => undefined,
            () => undefined,
        );
    const track = (p: Promise<unknown>): void => {
        const done = settled(p);
        busy = busy.then(() => done);
    };

    const read = (kv: KeyValue | null, key: string): string | null => {
        try {
            return kv ? kv.getItem(key) : null;
        } catch {
            return null;
        }
    };
    const owed = (): boolean => {
        const who = d.account();
        return who !== "" && read(d.local, PUSH_HELD_KEY) === who;
    };
    const noteOwed = (): void => {
        const who = d.account();
        if (!who) return;
        try {
            d.local?.setItem(PUSH_HELD_KEY, who);
        } catch {
            // No storage: the debt lives only as the gate's "held" flag of this page (see `released`).
        }
    };
    const settle = (): void => {
        try {
            d.local?.removeItem(PUSH_HELD_KEY);
        } catch {
            // nothing to clear
        }
    };
    const engineOk = (): boolean => read(d.session, ENGINE_OK_KEY) === "1";
    const setEngineOk = (): void => {
        try {
            d.session?.setItem(ENGINE_OK_KEY, "1");
        } catch {
            // Not remembered: the next owed upload asks the account for the engine part again.
        }
    };

    // What the app starts with (before any pull): the first "last agreed" state.
    const started = settled(
        Promise.resolve()
            .then(() => d.build())
            .then((json) => {
                if (synced === null) synced = json;
            }),
    );
    track(started);

    /** An upload was refused by the lock: is the local profile really different from the last agreed one? */
    const noteIfChanged = (): Promise<void> => {
        const run = (async () => {
            await started;
            let now: string | null = null;
            try {
                now = await d.build();
            } catch {
                // Cannot tell: better an upload too many than a change lost.
            }
            if (now === null || synced === null || now !== synced) noteOwed();
        })();
        const done = settled(run);
        noting = noting.then(() => done);
        track(done);
        return done;
    };

    /** An upload is waiting for its 4 s: decide now whether it is owed (the lock is going on or off). */
    const flushPending = async (): Promise<void> => {
        if (pushTimer === null) return;
        d.clearTimer(pushTimer);
        pushTimer = null;
        await noteIfChanged();
    };

    /**
     * Upload the local profile now. With an upload owed in a process whose engine state is not
     * known to be the DJ's, the engine part is taken from the account first; when the account
     * cannot be reached, nothing is uploaded and the debt stays. Returns true when uploaded.
     */
    const pushNow = async (): Promise<boolean> => {
        if (owed() && !engineOk()) {
            try {
                const account = await d.getProfile();
                if (account && (await d.applyEngineOnly(account)) === "locked") return false;
                setEngineOk();
            } catch {
                return false;
            }
            if (disposed || !d.signedIn() || !d.allowsPush()) return false;
        }
        try {
            const json = await d.build();
            await d.putProfile(json);
            synced = json;
            uploads++;
            settle();
            return true;
        } catch {
            // Offline / companion down: best effort. A debt stays written down; the next local
            // change, sign-in or start tries again.
            return false;
        }
    };

    /** Local wins: no pulled profile is applied; the local one is uploaded. */
    const uploadOwed = async (): Promise<PullOutcome> => {
        pulledForSession = true;
        // Nothing was settled when the upload fails: a later sign-in or start comes back here.
        if (!(await pushNow())) pulledForSession = false;
        return "kept";
    };

    const onTimer = async (): Promise<void> => {
        if (disposed || !d.signedIn()) return;
        // The lock is on (or went on while this upload was waiting): nothing goes out. A real
        // change is written down as owed.
        if (!d.allowsPush()) {
            await noteIfChanged();
            return;
        }
        await pushNow();
    };

    const changed = (): void => {
        if (disposed || !d.signedIn()) return;
        if (d.now() < suppressUntil) return;
        // Asked now as well, so the gate shows a held upload at once (popover: "cloud sync
        // waits"); the timer asks again before anything is sent.
        const allowed = d.allowsPush();
        // Locked and already written down as owed: nothing more to find out.
        if (!allowed && owed()) return;
        if (pushTimer !== null) d.clearTimer(pushTimer);
        pushTimer = d.setTimer(
            () => {
                pushTimer = null;
                track(onTimer());
            },
            allowed ? PUSH_DEBOUNCE_MS : HELD_NOTE_MS,
        );
    };

    const pull = async (): Promise<PullOutcome> => {
        if (disposed || !d.signedIn() || pulledForSession) return "skipped";
        if (!d.allowsPull()) return "skipped";
        if (owed()) return uploadOwed();
        pulledForSession = true;
        const uploadsBefore = uploads;
        try {
            const json = await d.getProfile();
            // The local profile was uploaded while the account was answering: that answer is
            // older than what the account holds now, and is dropped.
            if (uploads !== uploadsBefore) return "kept";
            if (!json) {
                // Nothing stored yet: there is no account copy the engine state could differ from.
                setEngineOk();
                return "empty";
            }
            // The lock went on while the account was answering: nothing is applied now, the
            // pull is made again after the unlock.
            if (!d.allowsPull()) {
                pulledForSession = false;
                return "skipped";
            }
            // An upload became owed while the account was answering: local wins, this answer is dropped.
            if (owed()) return uploadOwed();
            // Suppress change-driven uploads during / just after the apply so the freshly pulled
            // state is not uploaded straight back.
            suppressUntil = d.now() + PUSH_DEBOUNCE_MS;
            const result = await d.apply(json);
            // Only a profile that really landed can make the stores react; after an answer that
            // was not applied, a change in that moment is a change of the DJ's and must not be lost.
            suppressUntil = result === "applied" ? d.now() + AFTER_APPLY_MS : 0;
            if (result === "locked") {
                pulledForSession = false;
                return "skipped";
            }
            if (result === "unreadable") {
                setEngineOk();
                return "unreadable";
            }
            // The local state is the account's now: a debt (of any account) has nothing left to say.
            settle();
            setEngineOk();
            try {
                synced = await d.build();
            } catch {
                // The older reference stays: at worst one upload too many is owed later.
            }
            return "applied";
        } catch {
            pulledForSession = false; // allow a later retry on the next sign-in
            return "failed";
        }
    };

    const released = async (held: { pull: boolean; push: boolean }): Promise<void> => {
        if (disposed) return;
        // An upload refused less than 4 s ago is decided first (owed or not), so a held pull
        // cannot be applied over a change that was about to be written down.
        await flushPending();
        await noting;
        if (owed()) {
            if (d.signedIn() && d.allowsPush()) await uploadOwed();
            return;
        }
        // No marker (nothing really changed, or the storage could not hold it): the order from
        // before the marker existed.
        const first = releaseFirst(held);
        if (first === "pull") {
            const outcome = await pull();
            if (pushAfterPull(outcome, held.push)) changed();
        } else if (first === "push") changed();
    };

    return {
        pull,
        changed,
        signedIn: () => {
            pulledForSession = false;
            return pull();
        },
        lockedNow: () => (disposed ? Promise.resolve() : flushPending()),
        released,
        owed,
        idle: async () => {
            // Work can start more work: wait until nothing new was added.
            for (let seen: Promise<void> | null = null; seen !== busy; ) {
                seen = busy;
                await seen;
            }
        },
        dispose: () => {
            disposed = true;
            if (pushTimer !== null) d.clearTimer(pushTimer);
            pushTimer = null;
        },
    };
}
