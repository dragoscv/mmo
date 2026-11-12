// Run: node --test apps/mixai/src/link/link-math.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { LINK_OFF, bpmText, cleanPin, errorKey, isUnavailable, linkPhase, liveError, normalizeStatus, nudgeText, offsetUnit, offsetValueText, parseBpm, pinValid } from "./link-math.ts";

const RUNNING = { ...LINK_OFF, running: true, leader: true, bpm: 128, beat: 9.5, phase: 1.5, hostUs: 1_000, port: 42029 };

test("chip state: off, searching while alone or measuring, locked", () => {
    assert.equal(linkPhase(LINK_OFF), "off");
    assert.equal(linkPhase(RUNNING), "searching");
    assert.equal(linkPhase({ ...RUNNING, locked: true }), "locked");
    // A stopped session never reads as locked, whatever stale flag it carries.
    assert.equal(linkPhase({ running: false, locked: true }), "off");
});

test("a status from the shell is taken field by field; anything else reads as off", () => {
    assert.deepEqual(normalizeStatus(RUNNING), RUNNING);
    for (const bad of [null, undefined, "running", 42, [], {}, { running: "yes" }, { running: false, peers: 3 }]) {
        assert.deepEqual(normalizeStatus(bad), LINK_OFF, JSON.stringify(bad));
    }
    // The stub of an older shell answers nothing useful: no crash, off.
    assert.deepEqual(normalizeStatus({ error: "not available in this build" }), LINK_OFF);
    // Missing and broken fields get safe values, extra fields are dropped.
    const odd = normalizeStatus({ running: true, peers: -2, bpm: Number.NaN, offsetUs: "1", pending: 1.6, locked: 1, extra: true });
    assert.deepEqual(odd, { ...LINK_OFF, running: true, pending: 2 });
    assert.equal(normalizeStatus({ running: true, peers: 2, locked: true, leader: false, offsetUs: -1500 }).offsetUs, -1500);
    // The tempo lock is a strict boolean; a shell from before it (no field) reads as not locked.
    assert.equal(normalizeStatus({ ...RUNNING, tempoLocked: true }).tempoLocked, true);
    assert.equal(normalizeStatus({ running: true, tempoLocked: "yes" }).tempoLocked, false);
    assert.equal(normalizeStatus({ running: true }).tempoLocked, false);
    assert.equal(LINK_OFF.tempoLocked, false);
});

test("PIN field keeps four ASCII digits; valid = empty or exactly four", () => {
    assert.equal(cleanPin("12a3 4-5"), "1234");
    assert.equal(cleanPin("١٢٣٤"), "");
    assert.equal(cleanPin(""), "");
    for (const ok of ["", "0000", "4821"]) assert.ok(pinValid(ok), ok);
    for (const bad of ["1", "123", "12345", "12a4", " 1234", "١٢٣٤"]) assert.ok(!pinValid(bad), bad);
});

test("tempo input: 20..300, comma or point, nothing else", () => {
    assert.equal(parseBpm("128"), 128);
    assert.equal(parseBpm(" 128,5 "), 128.5);
    assert.equal(parseBpm("20"), 20);
    assert.equal(parseBpm("300"), 300);
    assert.equal(parseBpm("174."), 174);
    for (const bad of ["", "19.99", "300.01", "abc", "1e2", "-128", "NaN", "Infinity", "12 8", "128bpm"]) {
        assert.equal(parseBpm(bad), null, bad);
    }
});

test("readouts", () => {
    assert.equal(bpmText(128), "128.00");
    assert.equal(bpmText(129.166), "129.17");
    assert.equal(bpmText(0), "");
    assert.equal(bpmText(Number.NaN), "");
    // Clock offset: milliseconds below one second, seconds above; never longer than 7 characters
    // for a day of difference (the cell is about 10 characters wide with the unit).
    const offset = (us: number) => `${offsetValueText(us)} ${offsetUnit(us)}`;
    assert.equal(offset(0), "0.0 ms");
    assert.equal(offset(1_234), "1.2 ms");
    assert.equal(offset(-3_449), "−3.4 ms");
    assert.equal(offset(-40), "0.0 ms");
    assert.equal(offset(999_949), "999.9 ms");
    assert.equal(offset(999_950), "1.00 s");
    assert.equal(offset(-1_000_000), "−1.00 s");
    assert.equal(offset(-1_234_567), "−1.23 s");
    assert.equal(offset(99_994_000), "99.99 s");
    assert.equal(offset(99_996_000), "100 s");
    assert.equal(offset(-7_200_000_000), "−7200 s");
    assert.equal(offset(86_400_000_000), "86400 s");
    for (const us of [0, 1_234, -999_949, -1_234_567, -7_200_000_000, 86_400_000_000, -86_400_000_000]) {
        assert.ok(offsetValueText(us).length <= 7, `${us}: ${offsetValueText(us)}`);
    }
    assert.equal(offsetValueText(Number.POSITIVE_INFINITY), "");
    assert.equal(offsetValueText(Number.NaN), "");
    assert.equal(nudgeText(0), "0");
    assert.equal(nudgeText(0.004), "0");
    assert.equal(nudgeText(0.25), "+0.25");
    assert.equal(nudgeText(-0.5), "−0.50");
    assert.equal(nudgeText(Number.NaN), "0");
});

test("rejections: an old shell is 'not available', the rest maps to a message", () => {
    assert.ok(isUnavailable("not available in this build"));
    assert.ok(isUnavailable("Command link_status not found"));
    assert.ok(!isUnavailable("pin must be exactly 4 digits"));
    assert.ok(!isUnavailable("could not start tempo sync: Only one usage of each socket address"));
    assert.equal(errorKey("pin must be exactly 4 digits"), "link.err.pin");
    assert.equal(errorKey("bpm must be within 20..300"), "link.err.bpm");
    assert.equal(errorKey("could not start tempo sync: access denied"), "link.err.start");
    assert.equal(errorKey("bind must be a local IPv4 address"), "link.err.start");
    assert.equal(errorKey("tempo sync is not running"), "link.err.generic");
    assert.equal(errorKey(""), "link.err.generic");
    // The two refusals that name a state of the session get their own sentence.
    assert.equal(errorKey("tempo follows the playing deck"), "link.err.tempoLocked");
    assert.equal(errorKey("nudge is not available while this instance leads"), "link.err.nudgeLeader");
    assert.ok(!isUnavailable("tempo follows the playing deck"));
    assert.ok(!isUnavailable("nudge is not available while this instance leads"));
});

test("a refusal that names a session state is shown only while that state lasts", () => {
    const leaderLocked = { running: true, leader: true, tempoLocked: true };
    const follower = { running: true, leader: false, tempoLocked: false };
    assert.equal(liveError(null, leaderLocked), null);
    assert.equal(liveError("link.err.tempoLocked", leaderLocked), "link.err.tempoLocked");
    // The deck stopped: the tempo can be proposed again, the message goes.
    assert.equal(liveError("link.err.tempoLocked", { ...leaderLocked, tempoLocked: false }), null);
    assert.equal(liveError("link.err.nudgeLeader", leaderLocked), "link.err.nudgeLeader");
    // The lead moved to another instance: nudge works again here.
    assert.equal(liveError("link.err.nudgeLeader", follower), null);
    // Sync stopped: neither state exists.
    assert.equal(liveError("link.err.tempoLocked", { running: false, leader: false, tempoLocked: false }), null);
    assert.equal(liveError("link.err.nudgeLeader", { running: false, leader: true, tempoLocked: false }), null);
    // Messages about what was typed stay until the next command.
    for (const kept of ["link.err.pin", "link.err.bpm", "link.err.start", "link.err.generic"] as const) {
        assert.equal(liveError(kept, follower), kept);
    }
});
