// Run: cd apps/mixai; node --test src/gig/held-sync.test.ts
//
// The cloud profile auto-sync of the gig lock (F2), driven with a stand-in account and a fake
// clock: no bridge, no network, no store. What is pinned here is the POLICY — what the DJ
// changed on this computer wins over the account's older copy — and every way the debt
// (`mixai-cloud-push-held`) is written, cleared or ignored.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    AFTER_APPLY_MS,
    ENGINE_OK_KEY,
    HELD_NOTE_MS,
    PUSH_DEBOUNCE_MS,
    PUSH_HELD_KEY,
    createCloudSync,
    type ApplyResult,
    type KeyValue,
} from "./held-sync.ts";

/** A Storage that behaves like one: same object identity per key, and `broken` throws like a browser with storage off. */
function storage(init: Record<string, string> = {}) {
    const m = new Map<string, string>(Object.entries(init));
    return {
        raw: m,
        getItem: (k: string): string | null => m.get(k) ?? null,
        setItem: (k: string, v: string): void => void m.set(k, String(v)),
        removeItem: (k: string): void => void m.delete(k),
    };
}

const MINE = '{"skin":"mine"}';
const THEIRS = '{"skin":"theirs"}';

function harness(
    opts: {
        signedIn?: boolean;
        account?: string;
        /** What the account holds; null = nothing stored yet. */
        remote?: string | null;
        localStore?: Record<string, string>;
        sessionStore?: Record<string, string>;
        /** A blob the app refuses to apply (an account that holds something else). */
        apply?: (json: string) => ApplyResult;
        /** The account cannot be reached at all. */
        offline?: boolean;
        /** Hold the FIRST pull's answer until the test lets it through (later ones answer at once). */
        holdPull?: boolean;
    } = {},
) {
    let now = 1_000_000;
    const timers: { at: number; fn: () => void; id: number }[] = [];
    let nextId = 1;
    const account = opts.account ?? "u1";
    const signedIn = opts.signedIn ?? true;
    const local = storage(opts.localStore);
    const session = storage(opts.sessionStore);
    const state = {
        remote: opts.remote === undefined ? THEIRS : opts.remote,
        /** The gig lock: it stops a pull and an upload. */
        locked: false,
        /** What the local profile would be built as right now. */
        built: MINE,
        puts: [] as string[],
        gets: 0,
        applied: [] as string[],
        engineApplied: [] as string[],
        holds: [] as ((v: string | null) => void)[],
    };
    let held = false;
    const sync = createCloudSync({
        signedIn: () => signedIn,
        account: () => account,
        allowsPull: () => !state.locked,
        allowsPush: () => !state.locked,
        getProfile: async (): Promise<string | null> => {
            state.gets++;
            if (opts.offline) throw new Error("offline");
            if (opts.holdPull && !held) {
                held = true;
                return await new Promise<string | null>((resolve) => state.holds.push(resolve));
            }
            return state.remote;
        },
        putProfile: async (json: string) => {
            if (opts.offline) throw new Error("offline");
            state.puts.push(json);
            state.remote = json;
        },
        build: async (): Promise<string> => state.built,
        apply: async (json: string): Promise<ApplyResult> => {
            const r = opts.apply ? opts.apply(json) : "applied";
            if (r === "applied") state.applied.push(json);
            return r;
        },
        applyEngineOnly: async (json: string): Promise<ApplyResult> => {
            state.engineApplied.push(json);
            return opts.apply ? opts.apply(json) : "applied";
        },
        now: () => now,
        setTimer: (fn, ms) => {
            const id = nextId++;
            timers.push({ at: now + ms, fn, id });
            return id;
        },
        clearTimer: (h) => {
            const i = timers.findIndex((t) => t.id === h);
            if (i >= 0) timers.splice(i, 1);
        },
        local: local as KeyValue,
        session: session as KeyValue,
    });
    /** Move the clock, run the timers that are due, and let everything they started finish. */
    const advance = async (ms: number): Promise<void> => {
        now += ms;
        for (const t of timers.filter((x) => x.at <= now)) {
            const i = timers.indexOf(t);
            if (i >= 0) timers.splice(i, 1);
            t.fn();
        }
        await sync.idle();
    };
    /** The pull this test started, with its answer released when the test asks for it. */
    const release = (value: string | null): void => {
        const next = state.holds.shift();
        assert.ok(next, "no pull is waiting for an answer");
        next(value);
    };
    return { sync, state, local, session, advance, release };
}

test("a change while unlocked goes out after the 4 s debounce, and nothing else is uploaded", async () => {
    const h = harness();
    await h.advance(0);
    assert.deepEqual(h.state.puts, [], "nothing is uploaded before a change");
    h.state.built = '{"skin":"changed"}';
    h.sync.changed();
    await h.advance(PUSH_DEBOUNCE_MS - 1);
    assert.deepEqual(h.state.puts, [], "the 4 s are not over yet");
    await h.advance(1);
    assert.deepEqual(h.state.puts, ['{"skin":"changed"}'], "the change went out once");
});

test("locked: an upload is refused, a real change writes the debt, and at the unlock the local profile wins", async () => {
    const h = harness();
    await h.advance(0);
    h.state.locked = true;
    h.state.built = '{"skin":"changed while locked"}';
    h.sync.changed();
    await h.advance(HELD_NOTE_MS);
    assert.deepEqual(h.state.puts, [], "nothing is uploaded while locked");
    assert.equal(h.local.getItem(PUSH_HELD_KEY), "u1", "the debt is written down, under the account it is owed to");
    assert.equal(h.sync.owed(), true);
    // The lock is released: local wins.
    h.state.locked = false;
    await h.sync.released({ pull: true, push: true });
    await h.advance(0);
    assert.deepEqual(h.state.applied, [], "the account's older copy was NOT applied over the local change");
    assert.deepEqual(h.state.puts, ['{"skin":"changed while locked"}'], "the local profile was uploaded");
    assert.equal(h.local.getItem(PUSH_HELD_KEY), null, "a successful upload clears the debt");
    assert.equal(h.sync.owed(), false);
    // The MIDI mapping lives only in the engine: a fresh process takes it from the account first.
    assert.deepEqual(h.state.engineApplied, [THEIRS], "the engine-only part came from the account (tracker WP19-55)");
    assert.equal(h.session.getItem(ENGINE_OK_KEY), "1", "and the process knows the engine state is the DJ's now");
});

test("a pull on its way when the lock goes on is dropped, and the local profile goes out at the unlock", async () => {
    const h = harness({ holdPull: true });
    await h.advance(0);
    const pulling = h.sync.pull();
    h.state.locked = true;
    h.release(THEIRS);
    assert.equal(await pulling, "skipped", "an answer that arrives while locked is not applied");
    await h.sync.idle();
    assert.deepEqual(h.state.applied, []);
    // The change the DJ made while locked is owed; at the unlock the local profile is uploaded.
    h.state.built = '{"skin":"changed while locked"}';
    h.sync.changed();
    await h.advance(HELD_NOTE_MS);
    h.state.locked = false;
    await h.sync.released({ pull: true, push: true });
    assert.deepEqual(h.state.applied, []);
    assert.deepEqual(h.state.puts, ['{"skin":"changed while locked"}']);
});

test("an account that holds something else is not applied, and the local change keeps going out", async () => {
    const h = harness({ remote: '{"junk":1}', apply: () => "unreadable" });
    await h.advance(0);
    assert.equal(await h.sync.pull(), "unreadable");
    assert.deepEqual(h.state.applied, [], "nothing was applied");
    assert.equal(h.session.getItem(ENGINE_OK_KEY), "1", "the account holds no engine state to take");
    h.state.built = '{"skin":"changed"}';
    h.sync.changed();
    await h.advance(PUSH_DEBOUNCE_MS);
    assert.deepEqual(h.state.puts, ['{"skin":"changed"}']);
});

test("a debt of another account is not this account's debt", async () => {
    const h = harness({ account: "u2", localStore: { [PUSH_HELD_KEY]: "u1" } });
    await h.advance(0);
    assert.equal(h.sync.owed(), false);
    assert.equal(await h.sync.pull(), "applied", "another account's debt does not hold this one's pull back");
    assert.deepEqual(h.state.applied, [THEIRS]);
});

test("the debt is taken care of in a fresh process, and an unreachable account keeps it", async () => {
    const h = harness({ localStore: { [PUSH_HELD_KEY]: "u1" } });
    await h.advance(0);
    await h.sync.released({ pull: false, push: false });
    assert.deepEqual(h.state.engineApplied, [THEIRS], "the mapping that lives only in the engine came from the account");
    assert.deepEqual(h.state.puts, [MINE]);
    // A process whose engine state is already the DJ's does not make that detour.
    const known = harness({ localStore: { [PUSH_HELD_KEY]: "u1" }, sessionStore: { [ENGINE_OK_KEY]: "1" } });
    await known.advance(0);
    await known.sync.released({ pull: false, push: false });
    assert.deepEqual(known.state.engineApplied, []);
    assert.deepEqual(known.state.puts, [MINE]);
    // The account cannot be reached: nothing is uploaded, the debt stays.
    const offline = harness({ localStore: { [PUSH_HELD_KEY]: "u1" }, offline: true });
    await offline.advance(0);
    await offline.sync.released({ pull: false, push: false });
    assert.deepEqual(offline.state.puts, []);
    assert.equal(offline.local.getItem(PUSH_HELD_KEY), "u1", "an upload that failed keeps the debt written down");
});

test("an upload the lock refused that changed nothing leaves no debt", async () => {
    const h = harness();
    await h.advance(0);
    h.state.locked = true;
    // A store was "touched" without the profile changing (a HID report arrived, the palette opened).
    h.sync.changed();
    await h.advance(HELD_NOTE_MS);
    assert.equal(h.local.getItem(PUSH_HELD_KEY), null, "no real change: no debt");
    h.state.locked = false;
    await h.sync.released({ pull: true, push: true });
    await h.advance(PUSH_DEBOUNCE_MS);
    assert.deepEqual(h.state.applied, [THEIRS], "the account's copy is applied as it was before the marker existed");
    assert.deepEqual(h.state.puts, [], "and nothing is uploaded after it");
});

test("with no debt the order from before the lock stands: pull first, then a push only if it changed nothing", async () => {
    // Nothing in the account, a held push: it goes out.
    const empty = harness({ remote: null });
    await empty.advance(0);
    await empty.sync.released({ pull: true, push: true });
    await empty.advance(PUSH_DEBOUNCE_MS);
    assert.deepEqual(empty.state.applied, []);
    assert.deepEqual(empty.state.puts, [MINE]);
    // A pull that was applied: the held push is dropped, never uploaded back.
    const applied = harness();
    await applied.advance(0);
    await applied.sync.released({ pull: true, push: true });
    await applied.advance(PUSH_DEBOUNCE_MS);
    assert.deepEqual(applied.state.applied, [THEIRS]);
    assert.deepEqual(applied.state.puts, []);
    // A held push alone is not even announced as a skip by this module: it waits its 4 s as always.
    const pushOnly = harness({ remote: null });
    await pushOnly.advance(0);
    await pushOnly.sync.released({ pull: false, push: true });
    assert.deepEqual(pushOnly.state.gets, 0, "no pull was made");
    await pushOnly.advance(PUSH_DEBOUNCE_MS);
    assert.deepEqual(pushOnly.state.puts, [MINE]);
});

test("a freshly applied profile does not come back as an upload of its own", async () => {
    const h = harness();
    await h.advance(0);
    assert.equal(await h.sync.pull(), "applied");
    // The stores react to the applied profile and call `changed()`: inside the suppression window nothing is uploaded.
    h.state.built = THEIRS;
    h.sync.changed();
    await h.advance(AFTER_APPLY_MS);
    assert.deepEqual(h.state.puts, [], "what was just pulled is not uploaded back");
});

test("the lock going on decides an upload that was waiting for its 4 s", async () => {
    const h = harness();
    await h.advance(0);
    h.state.built = '{"skin":"changed"}';
    h.sync.changed();
    await h.advance(1000);
    h.state.locked = true;
    await h.sync.lockedNow();
    assert.deepEqual(h.state.puts, [], "the lock stopped it in time");
    assert.equal(h.local.getItem(PUSH_HELD_KEY), "u1", "the change was real: it is owed");
    await h.advance(PUSH_DEBOUNCE_MS);
    assert.deepEqual(h.state.puts, [], "and the timer is gone");
});

test("signed out: nothing is pulled, nothing is pushed, nothing is owed", async () => {
    const h = harness({ signedIn: false });
    await h.advance(0);
    assert.equal(await h.sync.pull(), "skipped");
    h.state.built = '{"skin":"changed"}';
    h.sync.changed();
    await h.advance(PUSH_DEBOUNCE_MS);
    assert.deepEqual(h.state.puts, []);
    assert.equal(h.state.gets, 0);
    assert.equal(h.sync.owed(), false);
});

test("dispose stops what was waiting", async () => {
    const h = harness();
    await h.advance(0);
    h.state.built = '{"skin":"changed"}';
    h.sync.changed();
    h.sync.dispose();
    await h.advance(PUSH_DEBOUNCE_MS);
    assert.deepEqual(h.state.puts, []);
});
