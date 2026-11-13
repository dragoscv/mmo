/**
 * Gig lock: the state and THE gate.
 *
 * `gigGate(action)` (and its shorthand `gigAllows`) is the one function every gate point of
 * the app calls: Settings (state/ui-store, settings/hotkey), settings changes
 * (settings/settings-live, settings/ProfileSwitcher, settings/profiles-store), the other doors
 * to a settings change (components/CommandPalette, state/keybind-store + the shortcuts
 * overlay, packs/pack-store, settings/skin-editor/store, layout/LayoutEditor), the cloud
 * profile sync (lib/cloud-sync), the controller layout switch (shell/shell-hotkeys), plugin
 * notifications (plugins/plugin-store) and closing the window (bridge/window). The rule itself
 * is `decide` in ./gig-core.ts; a test (contract.test.ts) fails when one of those files stops
 * asking.
 *
 * The lock is stored under its own localStorage key (`mixai-gig`), so:
 *   - a crash, a page reload or a restart during a set comes back LOCKED (and says so once);
 *   - a stored lock older than 12 hours is dropped at start (yesterday's set is over);
 *   - pop-out windows (own page, same storage) follow through the `storage` event;
 *   - it is not part of the settings file, of a settings profile or of the cloud profile
 *     (none of them reads this key: contract.test.ts pins that too).
 * An unreadable value reads as unlocked: the app can never start stuck.
 *
 * What the lock held back is kept for the popover: the counters and the texts of the last few
 * hidden notifications stay readable after the unlock, until the next lock (or page load).
 * They live in memory only.
 *
 * This module imports nothing of the app (only ./gig-core and dev/expose), because the stores
 * it guards import it. What needs the engine or the shell lives in ./gig-runtime.ts (shell
 * sync, hotkey, close request) and ./gig-checks.ts (the checklist).
 */
import { create } from "zustand";
import { devExpose } from "../dev/expose.ts";
import {
    GIG_KEY,
    NOTHING_SKIPPED,
    REFUSAL_NOTICE,
    UNLOCKED,
    UNLOCK_MIN_MS,
    UNLOCK_WINDOW_MS,
    confirmRefusal as refusalRule,
    confirmUnlock as confirmRule,
    decide,
    encodeStored,
    loadStored,
    noteHidden,
    noteSkip,
    parseStored,
    requestUnlock as requestRule,
    unlockPress,
    type Armed,
    type GigAction,
    type GigNotice,
    type GigVerdict,
    type HiddenToast,
    type ShellLink,
    type Skipped,
    type StoredGig,
    type UnlockStep,
    type WindowKind,
} from "./gig-core.ts";

/** Wall clock; replaced in tests. */
let clock: () => number = () => Date.now();
export function setGigClock(fn: () => number): void {
    clock = fn;
}

/** A pop-out window shows one panel (`index.html?popout=<panel>`); everything else is the main window. */
export const GIG_WINDOW: WindowKind = typeof location !== "undefined" && typeof location.search === "string" && new URLSearchParams(location.search).has("popout") ? "popout" : "main";

function storage(): Storage | null {
    try {
        return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
        return null;
    }
}

/** The stored lock as the app takes it at start (a lock older than 12 hours starts unlocked). */
function readStored(): { state: StoredGig; expired: boolean } {
    try {
        return loadStored(storage()?.getItem(GIG_KEY), Date.now());
    } catch {
        return { state: UNLOCKED, expired: false };
    }
}

/**
 * Store the lock. A failed write while LOCKING leaves the lock on for this page only. A failed
 * write while UNLOCKING must not leave "locked" behind for the next start: the key is removed
 * instead (an absent key reads as unlocked).
 */
function writeStored(s: StoredGig): void {
    const store = storage();
    try {
        store?.setItem(GIG_KEY, encodeStored(s));
    } catch {
        if (s.locked) return;
        try {
            store?.removeItem(GIG_KEY);
        } catch {
            // Storage is gone altogether: nothing is stored, so nothing says "locked".
        }
    }
}

export interface GigState {
    locked: boolean;
    /** Epoch ms the lock went on (0 = unlocked or not known). */
    since: number;
    /** First step of the unlock (epoch ms), null when none is under way. */
    armed: Armed;
    /** What was held back since the lock went on (kept after the unlock, until the next lock). */
    skipped: Skipped;
    /** The last few plugin notifications the lock hid, oldest first (kept like `skipped`; never stored). */
    hidden: readonly HiddenToast[];
    /** Something to say in the status region; `seq` changes on every notice. */
    notice: { id: GigNotice; seq: number } | null;
    /** Keep-awake as the shell reports it ("na" = this shell has no gig commands, "pending" = not asked yet, "unconfirmed" = the shell did not confirm the lock). */
    awake: ShellLink;
    /** The popover is open (the command palette opens it too). */
    open: boolean;
    /** The "close the app?" question is on screen. */
    closeAsk: boolean;
    lock: () => void;
    /** Step 1 of the unlock ("Unlock"): arms for 5 s. False when nothing was armed (not locked, or the same click that locked). */
    requestUnlock: () => boolean;
    /** Step 2 ("Confirm"): unlocks when step 1 is 0.6 to 5 s old and the app is still locked. */
    confirmUnlock: () => boolean;
    /** Why a Confirm pressed now would not unlock ("early" / "late" / "none"), or null when it would. */
    confirmRefusal: () => "early" | "late" | "none" | null;
    cancelUnlock: () => void;
    /** Ctrl/Cmd+Shift+G: lock when off; while locked the first press arms (said aloud) and a second one unlocks. */
    hotkey: () => UnlockStep | "locked";
    setOpen: (open: boolean) => void;
    setCloseAsk: (ask: boolean) => void;
    setAwake: (awake: ShellLink) => void;
}

let noticeSeq = 0;
const notice = (id: GigNotice) => ({ id, seq: ++noticeSeq });
let armTimer: ReturnType<typeof setTimeout> | null = null;

function clearArmTimer(): void {
    if (armTimer !== null) clearTimeout(armTimer);
    armTimer = null;
}

/** Arm step 1 at `armed` and let it lapse by itself (only so the controls go back; the rule is `confirmUnlock`). */
function arm(armed: Armed): void {
    clearArmTimer();
    armTimer = setTimeout(() => {
        armTimer = null;
        if (useGigStore.getState().armed === armed) useGigStore.setState({ armed: null });
    }, UNLOCK_WINDOW_MS + 30);
    (armTimer as { unref?: () => void }).unref?.();
    useGigStore.setState({ armed });
}

function unlockNow(): void {
    writeStored(UNLOCKED);
    clearArmTimer();
    const s = useGigStore.getState();
    // The held cloud sync is released by lib/cloud-sync (it watches this change); the counters
    // and the hidden notifications stay for the popover until the next lock.
    useGigStore.setState({ locked: false, since: 0, armed: null, closeAsk: false, skipped: { ...s.skipped, cloudPull: false, cloudPush: false }, notice: notice("unlocked") });
}

const initial = readStored();
// Yesterday's lock: dropped, and the stored value is put right so another window agrees.
if (initial.expired) writeStored(UNLOCKED);

export const useGigStore = create<GigState>((set, get) => ({
    locked: initial.state.locked,
    since: initial.state.since,
    armed: null,
    skipped: NOTHING_SKIPPED,
    hidden: [],
    // The app starts locked (a crash, a reload, a restart after "Close anyway"): it says so,
    // once, with the time. A lock dropped for its age is said too.
    notice: initial.state.locked ? notice("startLocked") : initial.expired ? notice("lockExpired") : null,
    awake: "pending",
    open: false,
    closeAsk: false,
    lock: () => {
        if (get().locked) return;
        const since = clock();
        writeStored({ locked: true, since });
        clearArmTimer();
        set({ locked: true, since, armed: null, skipped: NOTHING_SKIPPED, hidden: [], notice: notice("locked") });
    },
    requestUnlock: () => {
        const s = get();
        const now = clock();
        // Right after the lock went on: the tail of the click (or key) that locked, not a request.
        if (s.locked && now >= s.since && now - s.since < UNLOCK_MIN_MS) return false;
        const armed = requestRule(s.locked, now);
        if (armed === null) return false;
        arm(armed);
        return true;
    },
    confirmUnlock: () => {
        // Everything is read again here, at the second step: the lock may have gone meanwhile
        // (another window), and a first step older than the window no longer counts.
        const s = get();
        if (!confirmRule(s.locked, s.armed, clock())) return false;
        unlockNow();
        return true;
    },
    confirmRefusal: () => {
        const s = get();
        return refusalRule(s.locked, s.armed, clock());
    },
    cancelUnlock: () => {
        clearArmTimer();
        if (get().armed !== null) set({ armed: null });
    },
    hotkey: () => {
        const s = get();
        if (!s.locked) {
            get().lock();
            return "locked";
        }
        const { step, armed } = unlockPress(s.locked, s.armed, clock(), s.since);
        if (step === "armed") {
            arm(armed);
            set({ notice: notice("armedKey") });
        } else if (step === "unlocked") unlockNow();
        return step;
    },
    setOpen: (open) => {
        if (get().open !== open) set({ open });
    },
    setCloseAsk: (closeAsk) => {
        if (get().closeAsk !== closeAsk) set({ closeAsk });
    },
    setAwake: (awake) => {
        if (get().awake !== awake) set({ awake });
    },
}));

/**
 * THE gate. Ask before doing `action`:
 *   "allow"   go on (always, while the lock is off);
 *   "skip"    do nothing and report "skipped: locked" to your caller. The skip is counted
 *             (popover: "N notifications hidden", a held cloud sync) and, for something the DJ
 *             asked for with a click or a key, said in the status region;
 *   "confirm" ask the DJ first (closing the main window).
 * `detail` = the text of a plugin notification (`showToast`): the last few are kept for the popover.
 */
export function gigGate(action: GigAction, detail?: string): GigVerdict {
    const s = useGigStore.getState();
    const verdict = decide(s.locked, action, GIG_WINDOW);
    if (verdict !== "skip") return verdict;
    const skipped = noteSkip(s.skipped, action);
    const say = REFUSAL_NOTICE[action];
    const patch: Partial<GigState> = {};
    if (skipped !== s.skipped) patch.skipped = skipped;
    if (say) patch.notice = notice(say);
    if (action === "showToast") patch.hidden = noteHidden(s.hidden, detail, clock());
    if (patch.skipped || patch.notice || patch.hidden) useGigStore.setState(patch);
    return verdict;
}

/** `gigGate(action) === "allow"`. */
export function gigAllows(action: GigAction, detail?: string): boolean {
    return gigGate(action, detail) === "allow";
}

/** For controls that open Settings: are they locked right now? (They stay focusable and say why when pressed.) */
export function useGigLocked(): boolean {
    return useGigStore((s) => s.locked);
}

/**
 * Another window (or a test) changed the stored lock: follow it. `raw` is the new stored
 * value (null = removed). Nothing is written back.
 */
export function syncFromStorage(raw: string | null): void {
    const next = parseStored(raw);
    const s = useGigStore.getState();
    if (next.locked === s.locked && next.since === s.since) return;
    clearArmTimer();
    const fresh = next.locked && !s.locked;
    useGigStore.setState({
        locked: next.locked,
        since: next.since,
        armed: null,
        closeAsk: next.locked ? s.closeAsk : false,
        skipped: fresh ? NOTHING_SKIPPED : { ...s.skipped, cloudPull: next.locked && s.skipped.cloudPull, cloudPush: next.locked && s.skipped.cloudPush },
        hidden: fresh ? [] : s.hidden,
    });
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("storage", (e) => {
        // key null = the whole storage was cleared.
        if (e.key === null) syncFromStorage(null);
        else if (e.key === GIG_KEY) syncFromStorage(e.newValue);
    });
}

devExpose("gig", useGigStore);
