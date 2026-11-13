// Run: cd apps/mixai; node --test src/gig/gig-store.test.ts
//
// The store and THE gate, on a fake localStorage and a fake clock. The store module reads the
// stored lock when it loads, so each scenario that needs a fresh load imports it again with a
// query string (a new module instance).
import { test } from "node:test";
import assert from "node:assert/strict";
import { GIG_KEY, UNLOCK_MIN_MS, UNLOCK_WINDOW_MS } from "./gig-core.ts";

const mem = new Map<string, string>();
const fake = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
        return mem.size;
    },
};
Object.defineProperty(globalThis, "localStorage", { value: fake, configurable: true, writable: true });

type Mod = typeof import("./gig-store.ts");
let n = 0;
/** A fresh instance of the store module (reads the stored lock again), with its clock set to `clock`. */
async function load(clock: { now: number }): Promise<Mod> {
    const mod = (await import(`./gig-store.ts?fresh=${++n}`)) as Mod;
    mod.setGigClock(() => clock.now);
    return mod;
}

test("locking is one action: stored at once, with the time, and said", async () => {
    mem.clear();
    const clock = { now: 1_700_000_000_000 };
    const { useGigStore } = await load(clock);
    assert.equal(useGigStore.getState().locked, false);
    assert.equal(mem.get(GIG_KEY), undefined, "nothing is written until the lock is used");
    useGigStore.getState().lock();
    const s = useGigStore.getState();
    assert.deepEqual([s.locked, s.since, s.armed], [true, clock.now, null]);
    assert.deepEqual(JSON.parse(mem.get(GIG_KEY)!), { v: 1, locked: true, since: clock.now });
    assert.equal(s.notice?.id, "locked");
    // Locking again changes nothing (the time of the lock stays).
    clock.now += 5000;
    useGigStore.getState().lock();
    assert.equal(useGigStore.getState().since, 1_700_000_000_000);
});

test("a reload or a crash during a set comes back locked; a corrupt value comes back unlocked", async () => {
    mem.clear();
    // A lock of an hour ago: the set is still on (a lock older than 12 h is dropped at start).
    const since = Date.now() - 60 * 60 * 1000;
    mem.set(GIG_KEY, JSON.stringify({ v: 1, locked: true, since }));
    const a = await load({ now: 5000 });
    assert.deepEqual([a.useGigStore.getState().locked, a.useGigStore.getState().since], [true, since]);
    assert.equal(a.gigAllows("openSettings"), false, "the gates hold from the first moment");
    mem.set(GIG_KEY, '{"locked":tru');
    const b = await load({ now: 5000 });
    assert.equal(b.useGigStore.getState().locked, false);
    assert.equal(b.gigAllows("openSettings"), true);
    // A storage that throws: the app starts, unlocked.
    const boom = { ...fake, getItem: () => { throw new Error("denied"); } };
    Object.defineProperty(globalThis, "localStorage", { value: boom, configurable: true, writable: true });
    try {
        const c = await load({ now: 5000 });
        assert.equal(c.useGigStore.getState().locked, false);
    } finally {
        Object.defineProperty(globalThis, "localStorage", { value: fake, configurable: true, writable: true });
    }
});

test("unlock is two steps: Unlock arms, Confirm inside the window unlocks, and nothing else does", async () => {
    mem.clear();
    const clock = { now: 100_000 };
    const { useGigStore, gigAllows } = await load(clock);
    const st = () => useGigStore.getState();
    assert.equal(st().requestUnlock(), false, "not locked: nothing to arm");
    assert.equal(st().confirmUnlock(), false);
    st().lock();
    // The click that locked, bouncing 100 ms later: the same gesture, not a first step.
    clock.now += 100;
    assert.equal(st().requestUnlock(), false, "the tail of the click that locked");
    assert.equal(st().armed, null);
    // Confirm without the first step: still locked.
    clock.now += 9_900;
    assert.equal(st().confirmUnlock(), false);
    assert.equal(st().locked, true);
    // Step 1.
    assert.equal(st().requestUnlock(), true);
    const armedAt = clock.now;
    assert.equal(st().armed, armedAt);
    assert.equal(st().locked, true, "the first step alone never unlocks");
    assert.equal(gigAllows("openSettings"), false, "armed is still locked");
    // Step 2 too soon (a double click on the two buttons' spot).
    clock.now = armedAt + UNLOCK_MIN_MS - 1;
    assert.equal(st().confirmUnlock(), false);
    assert.equal(st().locked, true);
    // Step 2 too late.
    clock.now = armedAt + UNLOCK_WINDOW_MS + 1;
    assert.equal(st().confirmUnlock(), false);
    assert.equal(st().locked, true);
    // A fresh first step, then the second inside the window.
    assert.equal(st().requestUnlock(), true);
    clock.now += 1500;
    assert.equal(st().confirmUnlock(), true);
    assert.deepEqual([st().locked, st().since, st().armed], [false, 0, null]);
    assert.deepEqual(JSON.parse(mem.get(GIG_KEY)!), { v: 1, locked: false, since: 0 });
    assert.equal(st().notice?.id, "unlocked");
    assert.equal(gigAllows("openSettings"), true);
    st().cancelUnlock();
});

test("the first step can be taken back, and does not arm right after locking", async () => {
    mem.clear();
    const clock = { now: 200_000 };
    const { useGigStore } = await load(clock);
    const st = () => useGigStore.getState();
    st().lock();
    clock.now += UNLOCK_MIN_MS - 1;
    assert.equal(st().requestUnlock(), false, "the tail of the click that locked");
    assert.equal(st().armed, null);
    clock.now += 1;
    assert.equal(st().requestUnlock(), true);
    st().cancelUnlock();
    assert.equal(st().armed, null);
    clock.now += 1000;
    assert.equal(st().confirmUnlock(), false, "cancelled: Confirm does nothing");
    assert.equal(st().locked, true);
    st().cancelUnlock();
});

test("the hotkey locks with one press and unlocks only with two deliberate ones", async () => {
    mem.clear();
    const clock = { now: 300_000 };
    const { useGigStore } = await load(clock);
    const st = () => useGigStore.getState();
    assert.equal(st().hotkey(), "locked");
    assert.equal(st().locked, true);
    clock.now += 60_000;
    assert.equal(st().hotkey(), "armed");
    assert.equal(st().notice?.id, "armedKey", "the first press says what a second one will do");
    assert.equal(st().locked, true);
    clock.now += 100;
    assert.equal(st().hotkey(), "wait", "key bounce");
    assert.equal(st().locked, true);
    clock.now += 1000;
    assert.equal(st().hotkey(), "unlocked");
    assert.equal(st().locked, false);
    st().cancelUnlock();
});

test("THE gate: allow while off; while on it skips, counts what it held and says what the DJ asked for", async () => {
    mem.clear();
    const clock = { now: 400_000 };
    const { useGigStore, gigGate, gigAllows } = await load(clock);
    const st = () => useGigStore.getState();
    for (const a of ["openSettings", "applySettings", "switchProfile", "cloudPull", "cloudPush", "controllerLayout", "showToast", "closeWindow"] as const) assert.equal(gigGate(a), "allow", a);
    assert.deepEqual(st().skipped, { toasts: 0, layouts: 0, cloudPull: false, cloudPush: false }, "nothing is counted while off");
    assert.equal(st().notice, null);

    st().lock();
    const lockedNotice = st().notice!.seq;
    assert.equal(gigAllows("showToast"), false);
    assert.equal(gigAllows("showToast"), false);
    assert.equal(gigAllows("controllerLayout"), false);
    assert.equal(gigAllows("cloudPull"), false);
    assert.equal(gigAllows("cloudPush"), false);
    assert.equal(gigAllows("cloudPush"), false);
    assert.equal(gigAllows("applySettings"), false);
    assert.deepEqual(st().skipped, { toasts: 2, layouts: 1, cloudPull: true, cloudPush: true });
    assert.equal(st().notice!.seq, lockedNotice, "silent skips say nothing");
    // What the DJ asked for by hand is said, every time.
    assert.equal(gigAllows("openSettings"), false);
    const first = st().notice!;
    assert.equal(first.id, "openSettings");
    assert.equal(gigAllows("openSettings"), false);
    assert.ok(st().notice!.seq > first.seq, "asked again = said again");
    assert.equal(gigAllows("switchProfile"), false);
    assert.equal(st().notice!.id, "switchProfile");
    // Closing asks; it is neither allowed nor skipped.
    assert.equal(gigGate("closeWindow"), "confirm");
    assert.equal(gigAllows("closeWindow"), false);

    // Unlock: the gate opens, the held cloud sync is handed over (cleared), the counters stay for the popover.
    clock.now += 10_000;
    st().requestUnlock();
    clock.now += 1000;
    assert.equal(st().confirmUnlock(), true);
    assert.equal(gigAllows("showToast"), true);
    assert.deepEqual(st().skipped, { toasts: 2, layouts: 1, cloudPull: false, cloudPush: false });
    // A new lock starts counting from nothing.
    clock.now += 10_000;
    st().lock();
    assert.deepEqual(st().skipped, { toasts: 0, layouts: 0, cloudPull: false, cloudPush: false });
});

test("the store gives the held cloud sync to its listener at the moment of the unlock", async () => {
    mem.clear();
    const clock = { now: 500_000 };
    const { useGigStore, gigAllows } = await load(clock);
    const st = () => useGigStore.getState();
    const released: { pull: boolean; push: boolean }[] = [];
    // The exact form lib/cloud-sync.ts uses.
    const off = useGigStore.subscribe((s, prev) => {
        if (prev.locked && !s.locked) released.push({ pull: prev.skipped.cloudPull, push: prev.skipped.cloudPush });
    });
    st().lock();
    gigAllows("cloudPush");
    clock.now += 10_000;
    st().requestUnlock();
    assert.deepEqual(released, [], "arming releases nothing");
    clock.now += 1000;
    st().confirmUnlock();
    assert.deepEqual(released, [{ pull: false, push: true }]);
    off();
});

test("another window's lock is followed, and nothing is written back", async () => {
    mem.clear();
    const clock = { now: 600_000 };
    const { useGigStore, syncFromStorage, gigAllows } = await load(clock);
    const st = () => useGigStore.getState();
    syncFromStorage(JSON.stringify({ v: 1, locked: true, since: 777 }));
    assert.deepEqual([st().locked, st().since], [true, 777]);
    assert.equal(mem.get(GIG_KEY), undefined, "following is not writing");
    assert.equal(gigAllows("showToast"), false);
    assert.equal(st().skipped.toasts, 1);
    st().requestUnlock();
    assert.notEqual(st().armed, null);
    // The other window unlocked: this one follows and drops its half-done unlock and its question.
    st().setCloseAsk(true);
    syncFromStorage(JSON.stringify({ v: 1, locked: false, since: 0 }));
    assert.deepEqual([st().locked, st().armed, st().closeAsk], [false, null, false]);
    assert.equal(gigAllows("showToast"), true);
    // The key was removed, or the value is junk: unlocked.
    syncFromStorage(JSON.stringify({ v: 1, locked: true, since: 5 }));
    syncFromStorage(null);
    assert.equal(st().locked, false);
    syncFromStorage(JSON.stringify({ v: 1, locked: true, since: 5 }));
    syncFromStorage("garbage");
    assert.equal(st().locked, false);
});

test("an app that comes back locked says so once, with the time; a lock over 12 h old is dropped and said", async () => {
    mem.clear();
    // The store reads the stored lock against the WALL clock (not the injected one), as a real start does.
    const since = Date.now() - 60 * 60 * 1000;
    mem.set(GIG_KEY, JSON.stringify({ v: 1, locked: true, since }));
    const back = await load({ now: 5_000 });
    assert.equal(back.useGigStore.getState().locked, true);
    assert.equal(back.useGigStore.getState().notice?.id, "startLocked", "the DJ is told, once, that the set is still locked");
    assert.equal(back.useGigStore.getState().since, since, "with the time it was locked");
    // Older than 12 hours: dropped at start, and the drop is said too (and put right on disk).
    mem.set(GIG_KEY, JSON.stringify({ v: 1, locked: true, since: Date.now() - 13 * 60 * 60 * 1000 }));
    const old = await load({ now: 5_000 });
    assert.equal(old.useGigStore.getState().locked, false);
    assert.equal(old.useGigStore.getState().notice?.id, "lockExpired");
    assert.deepEqual(JSON.parse(mem.get(GIG_KEY)!), { v: 1, locked: false, since: 0 }, "another window agrees");
    // A fresh, unlocked start says nothing.
    mem.clear();
    const fresh = await load({ now: 5_000 });
    assert.equal(fresh.useGigStore.getState().notice, null);
});

test("a hidden notification is counted, and its text kept for the popover, in memory only", async () => {
    mem.clear();
    const clock = { now: 700_000 };
    const { useGigStore, gigAllows, gigGate } = await load(clock);
    const st = () => useGigStore.getState();
    st().lock();
    assert.equal(gigAllows("showToast", "Key clash: A and B are 2 semitones apart"), false);
    assert.equal(gigGate("showToast", "second notification"), "skip");
    assert.deepEqual(st().hidden.map((h) => h.text), ["Key clash: A and B are 2 semitones apart", "second notification"]);
    assert.deepEqual(st().hidden.map((h) => h.at), [clock.now, clock.now], "each with the time it was raised");
    assert.equal(st().skipped.toasts, 2);
    // Nothing of it is stored: it is for this session's popover only.
    assert.deepEqual(JSON.parse(mem.get(GIG_KEY)!), { v: 1, locked: true, since: clock.now });
    // The texts stay readable after the unlock (until the next lock), like the counters.
    clock.now += 10_000;
    assert.equal(st().requestUnlock(), true, "the first step of the unlock");
    clock.now += 1_000;
    assert.equal(st().confirmUnlock(), true);
    assert.equal(st().hidden.length, 2);
    // A new lock starts from nothing.
    st().lock();
    assert.deepEqual(st().hidden, []);
});

test("a write that fails while unlocking removes the stored key instead of leaving 'locked' behind", async () => {
    mem.clear();
    const clock = { now: 800_000 };
    const { useGigStore } = await load(clock);
    const st = () => useGigStore.getState();
    st().lock();
    assert.ok(mem.has(GIG_KEY));
    // A storage that holds the lock but refuses the unlock (quota, read-only profile).
    let refuse = false;
    const flaky = {
        getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
        setItem: (k: string, v: string) => {
            if (refuse) throw new Error("quota");
            mem.set(k, String(v));
        },
        removeItem: (k: string) => void mem.delete(k),
    };
    Object.defineProperty(globalThis, "localStorage", { value: flaky, configurable: true, writable: true });
    try {
        refuse = true;
        clock.now += 10_000;
        st().requestUnlock();
        clock.now += 1_000;
        assert.equal(st().confirmUnlock(), true, "the page still unlocks");
        assert.equal(st().locked, false);
        assert.equal(mem.has(GIG_KEY), false, "the key is removed: an absent key reads as unlocked");
        assert.equal(flaky.getItem(GIG_KEY), null);
    } finally {
        Object.defineProperty(globalThis, "localStorage", { value: fake, configurable: true, writable: true });
    }
});
