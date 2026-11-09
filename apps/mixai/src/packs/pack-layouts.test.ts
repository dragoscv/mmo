// Run: node --test apps/mixai/src/packs/pack-layouts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPackLayoutId, localLayoutId, packLayoutId, packLayouts, remapLegacyRef } from "./pack-layouts.ts";
import { BUILTIN_LAYOUTS, CLASSIC } from "../layout/presets.ts";
import { validateLayout } from "../layout/solver.ts";
import { PANEL_IDS } from "../layout/types.ts";
import { remapRefs, useLayoutStore } from "../layout/layout-store.ts";

const pack = (id: string, ...layouts: unknown[]) => ({ manifest: { id }, layouts });
const as = (id: string) => ({ ...CLASSIC, id, name: id });

test("pack layouts are namespaced by pack id", () => {
    const out = packLayouts([pack("com.example.layout.radio", as("radio-host"))]);
    assert.deepEqual(out.map((l) => l.id), ["com.example.layout.radio/radio-host"]);
    assert.equal(out[0]!.name, "radio-host");
});

test("a pack can not shadow a built-in layout id", () => {
    const out = packLayouts([pack("com.example.evil", as(CLASSIC.id))]);
    assert.equal(out.length, 1);
    assert.notEqual(out[0]!.id, CLASSIC.id);
    assert.ok(!BUILTIN_LAYOUTS.some((b) => b.id === out[0]!.id));
});

test("two packs with the same local id do not collide; duplicates inside one pack are dropped", () => {
    const out = packLayouts([pack("a.one", as("main"), as("main")), pack("b.two", as("main"))]);
    assert.deepEqual(out.map((l) => l.id), ["a.one/main", "b.two/main"]);
});

test("invalid pack layouts are dropped", () => {
    const out = packLayouts([pack("a.one", { v: 1, id: "x" }, as("ok"))]);
    assert.deepEqual(out.map((l) => l.id), ["a.one/ok"]);
});

test("a namespaced id can never pass the user layout validator (users can not overwrite a pack layout)", () => {
    assert.ok(validateLayout(as(packLayoutId("a.one", "main")), PANEL_IDS).length > 0);
    assert.equal(validateLayout(as("main"), PANEL_IDS).length, 0);
});

test("local and namespace helpers", () => {
    assert.equal(localLayoutId("a.one/main"), "main");
    assert.equal(localLayoutId("classic"), "classic");
    assert.ok(isPackLayoutId("a.one/main"));
    assert.ok(!isPackLayoutId("classic"));
});

test("legacy bare refs from Decks 1.3.0 move to the namespaced id only when unambiguous", () => {
    const layouts = packLayouts([pack("a.one", as("radio"), as("main")), pack("b.two", as("main"))]);
    const own = new Set(["classic", "my-layout"]);
    assert.equal(remapLegacyRef("radio", own, layouts), "a.one/radio");
    assert.equal(remapLegacyRef("main", own, layouts), "main", "ambiguous: left alone");
    assert.equal(remapLegacyRef("classic", own, layouts), "classic", "own layouts win");
    assert.equal(remapLegacyRef("a.one/radio", own, layouts), "a.one/radio");
    assert.equal(remapLegacyRef("gone", own, layouts), "gone");
});

const v130 = { activeId: "radio", user: [], snapshots: { "1": "radio", "2": "classic" }, controllerLayouts: { "DDJ-FLX4": "radio" } };

test("remapRefs moves every bare ref (active, snapshots, controller bindings)", () => {
    const layouts = packLayouts([pack("a.one", as("radio"))]);
    const out = remapRefs(v130, layouts);
    assert.equal(out.activeId, "a.one/radio");
    assert.deepEqual(out.snapshots, { "1": "a.one/radio", "2": "classic" });
    assert.deepEqual(out.controllerLayouts, { "DDJ-FLX4": "a.one/radio" });
    assert.equal(remapRefs(v130, []), v130, "no packs loaded yet: untouched");
});

test("store: packs loading remaps saved refs, and restoring a 1.3.0 export after packs loaded remaps too", () => {
    const s = useLayoutStore.getState();
    s.restore({ ...v130 });
    assert.equal(useLayoutStore.getState().activeId, "radio", "packs not loaded yet");
    s.setPackLayouts(packLayouts([pack("a.one", as("radio"))]));
    assert.equal(useLayoutStore.getState().activeId, "a.one/radio");
    assert.equal(useLayoutStore.getState().active().id, "a.one/radio");
    useLayoutStore.getState().restore({ ...v130 });
    assert.equal(useLayoutStore.getState().activeId, "a.one/radio");
    assert.equal(useLayoutStore.getState().snapshots["1"], "a.one/radio");
});
