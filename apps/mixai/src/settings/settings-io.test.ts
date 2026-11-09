// Run: node --test apps/mixai/src/settings/settings-io.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    SETTINGS_FORMAT,
    buildFile,
    diff,
    exportFileName,
    groupDiff,
    joinAppearance,
    migrate,
    pickSections,
    splitAppearance,
    type Sections,
} from "./settings-io.ts";
import { emptyProfiles, normalizeProfiles, upsertProfile, removeProfile, SEED_IDS } from "./profiles-core.ts";
import { pushUndo, popUndo } from "./undo-core.ts";
import { searchSettings, SETTINGS_INDEX } from "./search-index.ts";

const v1 = {
    v: 1,
    prefs: { mode: "dark", accent: "cyan", surface: "glass" },
    deckCount: 4,
    companion: { baseUrl: "http://127.0.0.1:17899", deviceToken: "secret-token", userId: "u1" },
    midiPreset: { name: "DDJ-FLX4", mappings: [{ status: 144, midino: 11, action: "play", deck: "a", type: "note" }] },
    hidPreset: { name: "Custom HID mapping", vendorId: 0, productId: 0, mappings: [] },
    externalPlugins: [{ id: "x", name: "X" }],
    keybinds: { "a:play": "KeyE" },
};

test("migrate v1 profile blob to v2 sections", () => {
    const f = migrate(JSON.stringify(v1));
    assert.ok(f);
    assert.equal(f.format, SETTINGS_FORMAT);
    assert.equal(f.v, 2);
    assert.deepEqual(f.sections.appearance, v1.prefs);
    assert.deepEqual(f.sections.layout, { deckCount: 4 });
    assert.deepEqual(f.sections.library, v1.companion);
    assert.deepEqual(f.sections.midi, v1.midiPreset);
    assert.deepEqual(f.sections.hid, v1.hidPreset);
    assert.deepEqual(f.sections.plugins, { external: v1.externalPlugins });
    assert.deepEqual(f.sections.keyboard, v1.keybinds);
});

test("migrate keeps v2, drops unknown sections, rejects junk and future versions", () => {
    const f = migrate({ format: SETTINGS_FORMAT, v: 2, exportedAt: "x", app: "1.2.0", sections: { appearance: { mode: "light" }, bogus: 1 } });
    assert.ok(f);
    assert.deepEqual(Object.keys(f.sections), ["appearance"]);
    assert.equal(migrate("not json"), null);
    assert.equal(migrate({ foo: 1 }), null);
    assert.equal(migrate({ format: SETTINGS_FORMAT, v: 3, sections: { appearance: {} } }), null);
    assert.equal(migrate({ v: 1, theme: "neon-glass" })?.sections.appearance?.toString(), { surface: "glass" }.toString());
});

test("diff lists changed leaves only, with paths", () => {
    const cur: Sections = { appearance: { mode: "dark", accent: "cyan" }, keyboard: { a: "KeyQ" }, midi: { name: "A", mappings: [{ x: 1 }, { x: 2 }] } };
    const inc: Sections = { appearance: { mode: "light", accent: "cyan" }, midi: { name: "A", mappings: [{ x: 1 }, { x: 3 }, { x: 4 }] } };
    const d = diff(cur, inc);
    assert.deepEqual(
        d.map((e) => [e.section, e.path, e.before, e.after]),
        [
            ["appearance", "mode", "dark", "light"],
            ["midi", "mappings[1].x", 2, 3],
            ["midi", "mappings[2]", undefined, { x: 4 }],
        ],
    );
    // keyboard absent in incoming -> untouched, no entries
    const g = groupDiff(d, ["appearance", "midi"]);
    assert.equal(g.appearance.length, 1);
    assert.equal(g.keyboard.length, 0);
    assert.deepEqual(diff(cur, cur), []);
});

test("buildFile excludes library by default and includes it only when picked", () => {
    const sections = migrate(v1)!.sections;
    const def = buildFile(sections, { app: "1.2.0", now: new Date("2026-11-09T10:00:00Z") });
    assert.equal(def.sections.library, undefined);
    assert.ok(def.sections.appearance);
    assert.equal(def.exportedAt, "2026-11-09T10:00:00.000Z");
    const withLib = buildFile(sections, { app: "1.2.0", picked: ["library"] });
    assert.deepEqual(Object.keys(withLib.sections), ["library"]);
    assert.deepEqual(Object.keys(pickSections(sections, ["midi", "hid"])), ["midi", "hid"]);
    assert.equal(exportFileName(new Date(2026, 0, 5)), "mixai-decks-settings-2026-01-05.json");
});

test("profiles: seeds survive, delete refuses seeds, data never carries library", () => {
    let p = emptyProfiles();
    assert.deepEqual(p.profiles.map((x) => x.id), [...SEED_IDS]);
    p = upsertProfile(p, { id: "home", name: "Home", icon: "home", data: { appearance: { mode: "dark" }, library: { deviceToken: "t" } } });
    assert.equal(p.profiles.find((x) => x.id === "home")?.data.library, undefined);
    assert.equal(removeProfile(p, "club").profiles.length, 3);
    p = upsertProfile(p, { id: "mine", name: "Mine", icon: "user", data: {} });
    assert.equal(removeProfile(p, "mine").profiles.length, 3);
    const n = normalizeProfiles({ active: "zzz", profiles: [{ id: "x" }] });
    assert.equal(n.active, null);
    assert.deepEqual(n.profiles.map((x) => x.id).slice(0, 3), [...SEED_IDS]);
});

test("appearance carries shell prefs and skin; old files stay valid", () => {
    const joined = joinAppearance({
        prefs: { mode: "dark", accent: "cyan" },
        shell: { hud: true, palette: "tritanopia", onboarded: true },
        skin: "ro.mixai.skin.booth",
    });
    assert.deepEqual(joined, { mode: "dark", accent: "cyan", shell: { hud: true, palette: "tritanopia" }, skin: "ro.mixai.skin.booth" });
    const parts = splitAppearance(joined);
    assert.deepEqual(parts.prefs, { mode: "dark", accent: "cyan" });
    assert.deepEqual(parts.shell, { hud: true, palette: "tritanopia" });
    assert.equal(parts.skin, "ro.mixai.skin.booth");
    // default skin round-trips as null (explicit reset), absent = untouched
    assert.equal(splitAppearance(joinAppearance({ prefs: {}, skin: null })).skin, null);
    // v1 profile: flat prefs only, no shell/skin -> both untouched
    const v1parts = splitAppearance(migrate(v1)!.sections.appearance);
    assert.deepEqual(v1parts.prefs, v1.prefs);
    assert.equal(v1parts.shell, undefined);
    assert.equal(v1parts.skin, undefined);
    // early v2 file without shell/skin still migrates and diffs leaf by leaf
    const f = migrate({ format: SETTINGS_FORMAT, v: 2, sections: { appearance: { mode: "light" } } })!;
    assert.equal(splitAppearance(f.sections.appearance).skin, undefined);
    const d = diff({ appearance: joined }, { appearance: { ...(joined as object), shell: { hud: false, palette: "tritanopia" } } });
    assert.deepEqual(d.map((e) => e.path), ["shell.hud"]);
    // garbage is ignored
    assert.deepEqual(splitAppearance("x" as never), { prefs: {} });
    assert.equal(splitAppearance({ skin: 42 } as never).skin, undefined);
});

test("undo stack keeps the last 10", () => {
    let s: number[] = [];
    for (let i = 0; i < 12; i++) s = pushUndo(s, i);
    assert.equal(s.length, 10);
    const [top, rest] = popUndo(s);
    assert.equal(top, 11);
    assert.equal(rest.length, 9);
});

test("search index: unique ids, matches label keywords across tabs", () => {
    const ids = SETTINGS_INDEX.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    const label = (k: string) => k;
    assert.ok(searchSettings("latency", label).some((e) => e.id === "audio.latency"));
    assert.ok(searchSettings("bluetooth", label).some((e) => e.tab === "controllers"));
    assert.deepEqual(searchSettings("  ", label), []);
});
