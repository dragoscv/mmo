// Run: node --test apps/mixai/src/packs/base-prefs.test.ts
//
// Review P0: the prefs from before a skin were kept as a FULL snapshot and re-imposed at the
// next launch, skin switch and skin removal, so a Settings change made while a skin was on
// (language, reduced motion, an accent the skin does not set) was silently undone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SKIN_PREF_KEYS, parseBasePrefs, skinPrefsStep, type BasePrefs, type SkinPrefs } from "./base-prefs.ts";

interface Prefs {
    mode: string;
    accent: string;
    surface: string;
    density: string;
    radius: string;
    motion: string;
    locale: string;
    feedback: boolean;
}

const DEFAULTS: Prefs = { mode: "system", accent: "violet", surface: "glass", density: "comfortable", radius: "md", motion: "full", locale: "ro", feedback: false };
const ALLOWED: Record<string, readonly unknown[]> = {
    mode: ["light", "dark", "system"],
    accent: ["violet", "magenta", "cyan", "emerald", "amber", "rose"],
    surface: ["glass", "solid", "flat"],
    density: ["comfortable", "compact"],
    radius: ["sm", "md", "lg"],
    motion: ["full", "reduced"],
    locale: ["ro", "en"],
    feedback: [true, false],
};

/** Same contract as `normalizePrefs` in @mmo/design-tokens: unknown values become the default. */
function normalize(input: unknown): Prefs {
    const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, def] of Object.entries(DEFAULTS)) out[k] = ALLOWED[k]!.includes(o[k]) ? o[k] : def;
    return out as unknown as Prefs;
}

/** localStorage as the pack store uses it: the saved prefs and the base (JSON text or absent). */
interface Disk {
    saved: Prefs;
    base: string | null;
}

/** A persisted render, the way `renderSkin` does it: read the base, step, write both back. */
function render(disk: Disk, skin: SkinPrefs | null): Prefs {
    const step = skinPrefsStep(disk.saved, parseBasePrefs(disk.base, normalize), skin);
    disk.saved = step.next;
    disk.base = step.base ? JSON.stringify(step.base) : null;
    return step.next;
}

/** What Settings does: change saved prefs directly, whatever skin is on. */
function settings(disk: Disk, patch: Partial<Prefs>): void {
    disk.saved = { ...disk.saved, ...patch };
}

const USER: Prefs = { mode: "light", accent: "emerald", surface: "solid", density: "comfortable", radius: "md", motion: "full", locale: "ro", feedback: false };
/** Like Mainroom: sets four dimensions, no accent. */
const SKIN_A: SkinPrefs = { mode: "dark", surface: "flat", density: "compact", radius: "sm" };
/** Like a light skin with its own accent, and no radius. */
const SKIN_B: SkinPrefs = { mode: "light", surface: "flat", density: "comfortable", accent: "amber" };

/** A skin is applied, then the user changes three things the skin does not set. */
function skinOnThenSettings(): Disk {
    const disk: Disk = { saved: { ...USER }, base: null };
    render(disk, SKIN_A);
    settings(disk, { locale: "en", motion: "reduced", accent: "rose" });
    return disk;
}

test("prefs changed while a skin is on survive a restart render", () => {
    const disk = skinOnThenSettings();
    // Next launch: the active skin is rendered again from what is on disk.
    const shown = render(disk, SKIN_A);
    assert.equal(shown.locale, "en", "language chosen while the skin was on");
    assert.equal(shown.motion, "reduced", "reduced motion chosen while the skin was on");
    assert.equal(shown.accent, "rose", "an accent the skin does not set");
    // The skin's own dimensions are still the skin's.
    assert.deepEqual([shown.mode, shown.surface, shown.density, shown.radius], ["dark", "flat", "compact", "sm"]);
    // And a second launch changes nothing.
    assert.deepEqual(render(disk, SKIN_A), shown);
});

test("prefs changed while a skin is on survive switching to another skin", () => {
    const disk = skinOnThenSettings();
    const shown = render(disk, SKIN_B);
    assert.equal(shown.locale, "en");
    assert.equal(shown.motion, "reduced");
    // B sets its own accent; the user's (changed while A was on) is what comes back after B.
    assert.equal(shown.accent, "amber");
    assert.equal((JSON.parse(disk.base!) as BasePrefs<Prefs>).accent, "rose");
    // A set the radius, B does not: it is the user's again and no longer remembered.
    assert.equal(shown.radius, "md");
    assert.equal(Object.hasOwn(JSON.parse(disk.base!) as object, "radius"), false);
    // The user's pre-skin values are still the base for what both skins set (never A's values).
    assert.equal((JSON.parse(disk.base!) as BasePrefs<Prefs>).surface, "solid");
});

test("prefs changed while a skin is on survive removing the skin", () => {
    const disk = skinOnThenSettings();
    const shown = render(disk, null);
    assert.deepEqual(shown, { ...USER, locale: "en", motion: "reduced", accent: "rose" });
    assert.equal(disk.base, null, "nothing is remembered once the skin is gone");
    // Through a second skin first, the result is the same.
    const viaB = skinOnThenSettings();
    render(viaB, SKIN_B);
    assert.deepEqual(render(viaB, null), { ...USER, locale: "en", motion: "reduced", accent: "rose" });
});

test("the base holds only the dimensions the skin overrides", () => {
    const disk: Disk = { saved: { ...USER }, base: null };
    render(disk, SKIN_A);
    assert.deepEqual(JSON.parse(disk.base!), { mode: "light", surface: "solid", density: "comfortable", radius: "md" });
    // A skin without theme dimensions remembers nothing and leaves the prefs alone.
    const plain: Disk = { saved: { ...USER }, base: null };
    assert.deepEqual(render(plain, {}), USER);
    assert.equal(plain.base, null);
});

test("a full snapshot from an earlier build is reduced to the five skin dimensions", () => {
    const old = JSON.stringify({ ...USER, locale: "ro", motion: "full", feedback: false });
    const base = parseBasePrefs(old, normalize);
    assert.deepEqual(Object.keys(base!).sort(), [...SKIN_PREF_KEYS].sort());
    // So it can no longer bring back the old language or motion.
    const disk: Disk = { saved: { ...USER, ...SKIN_A, locale: "en", motion: "reduced" } as Prefs, base: old };
    const shown = render(disk, null);
    assert.equal(shown.locale, "en");
    assert.equal(shown.motion, "reduced");
    assert.equal(shown.density, "comfortable");
});

test("a corrupted base never throws and never reaches the theme", () => {
    for (const raw of [null, undefined, "", "{bad json", "null", '"dark"', "42", "[1,2]", "{}"]) assert.equal(parseBasePrefs(raw, normalize), null, String(raw));
    // Wrong types and unknown values are dropped key by key (a number as accent used to throw at startup).
    assert.deepEqual(parseBasePrefs('{"accent":5,"mode":"dark","surface":null,"density":"huge","radius":["sm"]}', normalize), { mode: "dark" });
    assert.equal(parseBasePrefs('{"accent":{"startsWith":1},"locale":"en"}', normalize), null);
    // Prototype names are not dimensions.
    assert.equal(parseBasePrefs('{"__proto__":{"mode":"dark"},"constructor":"x"}', normalize), null);
});
