// Run: cd apps/mixai; node --test src/setlog/contract.test.ts
//
// Rules of the tracklist UI that only show at run time in the native app, checked against the
// SOURCE: the popover keeps bare arrows from the crossfader shortcuts, no focusable control is
// switched off with the native `disabled`, every string is in the catalogue in both languages,
// and the feature is wired where the app expects it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setlogMessages } from "../i18n/messages-setlog.ts";
import { tracksKey } from "./setlog-core.ts";
import { copyKey, uploadKeys } from "./actions.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const buttonSrc = read("./SetlogButton.tsx");
const popoverSrc = read("./SetlogPopover.tsx");
const storeSrc = read("./setlog-store.ts");
const cssSrc = read("./setlog.css");

test("bare arrows pressed in the popover never reach the crossfader shortcuts", () => {
    // The app binds bare arrows globally to the crossfader (lib/shortcuts.ts): a popover must
    // consume the ones nothing inside used, like the link, remote, practice and co-pilot popovers.
    const code = strip(buttonSrc);
    assert.match(code, /import \{ consumeBareArrows \} from "@\/remote\/remote-core";/);
    assert.match(code, /<PopoverContent[^>]*onKeyDown=\{\(e\) => \{\s*consumeBareArrows\(e\);\s*\}\}/);
    assert.equal((code.match(/<PopoverContent/g) ?? []).length, 1, "one popover, one guard");
});

test("no focusable control is switched off with the native disabled", () => {
    // `disabled` on the element that holds the focus sends the focus to <body>; the next arrow
    // key would then be a crossfader shortcut. Buttons are aria-disabled and say why.
    for (const [name, src] of [
        ["SetlogButton.tsx", buttonSrc],
        ["SetlogPopover.tsx", popoverSrc],
    ] as const) {
        assert.doesNotMatch(strip(src), /\sdisabled(=|\s|>)/, `a native disabled attribute is in ${name}`);
    }
    assert.match(strip(popoverSrc), /aria-disabled=\{entries\.length === 0 \|\| undefined\}/);
    assert.match(strip(popoverSrc), /aria-disabled=\{recording \|\| !set \|\| undefined\}/);
});

test("zustand selectors return stored values, never a freshly built array or object", () => {
    // `useStore((s) => s.list.filter(...))` gives a new array each call: React then throws
    // "The result of getSnapshot should be cached" and the panel dies.
    for (const src of [buttonSrc, popoverSrc]) {
        for (const m of strip(src).matchAll(/useSetlogStore\(\(s\) => ([^)]*(?:\([^)]*\))?[^)]*)\)/g)) {
            const body = m[1]!;
            assert.doesNotMatch(body, /\.(map|filter|slice|concat|entries\(\)|flat)\b|\[\.\.\.|\{\s*\w+:|\?\? \[\]/, `selector builds a value: ${body}`);
        }
    }
    assert.match(strip(popoverSrc), /const NO_ENTRIES: readonly Entry\[\] = \[\];/, "the empty list is one shared constant");
});

test("the list scrolls inside the popover, and sizes come from the touch tokens", () => {
    const css = cssSrc.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(css, /\.sl-pop\[data-slot="popover-content"\] \{[^}]*--sl-min: var\(--dt-min, 24px\);/);
    assert.match(css, /\.sl-pop\[data-slot="popover-content"\] \{[^}]*max-height: min\(var\(--available-height, 100vh\), 520px\);/);
    assert.match(css, /\.sl-list \{[^}]*overflow-y: auto;/);
    assert.match(css, /\.sl-row \{[^}]*min-height: var\(--sl-min\);/);
    assert.match(css, /\.sl-pop\[data-slot="popover-content"\] \{[^}]*width: min\(92vw, 432px\);/);
    // The popover hangs below the title bar: its largest height + the title bar must fit the smallest
    // window. All three numbers are READ from the sources that define them.
    const maxH = Number(/\.sl-pop\[data-slot="popover-content"\] \{[^}]*max-height: min\(var\(--available-height, 100vh\), (\d+)px\);/.exec(css)?.[1]);
    const titleBar = Number(/--titlebar-h: (\d+)px;/.exec(read("../look/look.css"))?.[1]);
    const minWindow = Number(/setMinSize\(Math\.max\(\d+, [^)]*\), Math\.max\((\d+),/.exec(read("../App.tsx"))?.[1]);
    assert.ok(maxH > 0 && titleBar > 0 && minWindow > 0, `sizes not found: popover ${maxH}, title bar ${titleBar}, window ${minWindow}`);
    assert.ok(maxH + titleBar + 8 <= minWindow, `popover ${maxH} px + title bar ${titleBar} px + 8 px gap does not fit a ${minWindow} px window`);
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|oklch\(/, "colours only from tokens");
    // The number column grows from the 100th entry (three digits).
    assert.match(css, /\.sl-list\[data-many\] \{[^}]*--sl-num:/);
    assert.match(strip(popoverSrc), /data-many=\{entries\.length >= 100 \|\| undefined\}/);
});

test("the store samples the mixer only while a recording runs, and persists under its own key", () => {
    const code = strip(storeSrc);
    assert.match(code, /useRecordingStore\.subscribe\(/);
    assert.match(code, /useMixerStore\.subscribe\(\(s, prev\) => \{\s*if \(!session\) return;/);
    assert.match(code, /if \(s\.decks === prev\.decks && s\.crossfader === prev\.crossfader\) return;/);
    assert.match(read("./setlog-core.ts"), /export const STORAGE_KEY = "mixai-setlog";/);
});

test("the store keeps time with a monotonic timer and saves what a closed window would lose", () => {
    const code = strip(storeSrc);
    // Set time = start + performance.now() delta: the system clock is read once, when the log begins.
    assert.match(code, /clock = sessionClock\(startedAt, Date\.now\(\), mono\(\)\);/);
    assert.equal((code.match(/Date\.now\(\)/g) ?? []).length, 3, "Date.now() only in mono()'s fallback, in now()'s fallback and at begin");
    // Every time handed to the session comes from that clock.
    assert.match(code, /session\.remove\(index, now\(\)\)/);
    assert.match(code, /session\.finish\(now\(\)\)/);
    assert.match(code, /const at = now\(\);\s*const m = useMixerStore\.getState\(\);\s*const next = session\.sample\(at, m\.decks, m\.crossfader\);/);
    // A closed or reloaded window, and a crash: the running set is written on pagehide and once a minute.
    assert.match(code, /window\.addEventListener\("pagehide", onPageHide\)/);
    assert.match(code, /window\.removeEventListener\("pagehide", onPageHide\)/);
    assert.match(code, /else if \(lastSample - lastPersist >= PERSIST_GAP_MS\) save\(session\.snapshot\(at\)\);/);
    // A recording without a track does not overwrite the earlier set, in storage or at the end.
    assert.match(code, /if \(!mayPersist\(set, previous\)\) return;/);
    assert.match(code, /const kept = keptAtEnd\(session\.finish\(now\(\)\), previous\);/);
});

test("the sentence about the browser stays on screen, and Clear checks the recording again", () => {
    const code = strip(popoverSrc);
    // Upload sends the DJ to the browser: its sentence has no expiry (hold), every other one has.
    assert.match(code, /say\(`\$\{t\(opened\)\} \$\{t\(clip\)\}`, true\);/);
    assert.match(code, /if \(!hold\) timers\.current\.push\(window\.setTimeout\(\(\) => setStatus\(""\), STATUS_MS\)\);/);
    assert.equal((code.match(/say\([^;]*, true\)/g) ?? []).length, 1, "only the Upload sentence is held");
    // "Yes, clear" while a recording has started in the meantime: says why, clears nothing.
    assert.match(code, /const doClear = \(\) => \{\s*if \(useSetlogStore\.getState\(\)\.recording\) \{[\s\S]*?return say\(t\("setlog\.clearBusy"\)\);\s*\}/);
});

test("the feature is wired: title bar after REC, app start, command palette, stylesheet, catalogue", () => {
    const titleBar = strip(read("../shell/TitleBar.tsx"));
    assert.match(titleBar, /\{native && <RecordButton \/>\}\s*\{native && <SetlogButton \/>\}/);
    const app = strip(read("../App.tsx"));
    assert.match(app, /useEffect\(\(\) => startSetLog\(\), \[\]\);/);
    const palette = strip(read("../components/CommandPalette.tsx"));
    assert.match(palette, /id: "setlog",[\s\S]*?label: t\("setlog\.command"\),[\s\S]*?useSetlogStore\.getState\(\)\.setOpen\(true\)/);
    assert.match(read("../styles.css"), /@import "\.\/setlog\/setlog\.css";/);
    assert.match(read("../i18n/catalog.ts"), /\n {4}setlogMessages,\n\] as const;/);
});

test("every key the UI asks for exists in both languages, and the two differ where they must", () => {
    const en = setlogMessages.en as Record<string, string>;
    const ro = setlogMessages.ro as Record<string, string>;
    const used = new Set<string>();
    for (const src of [buttonSrc, popoverSrc, read("../components/CommandPalette.tsx")]) for (const m of src.matchAll(/"(setlog\.[A-Za-z0-9.]+)"/g)) used.add(m[1]!);
    for (const r of ["copied", "empty", "failed"] as const) used.add(copyKey(r));
    for (const open of ["opened", "refused", "failed"] as const) for (const copy of ["copied", "empty", "failed"] as const) for (const k of uploadKeys({ open, copy })) used.add(k);
    for (const n of [0, 1, 2, 20]) for (const l of ["en", "ro"]) used.add(tracksKey(n, l));
    assert.ok(used.size >= 30, `only ${used.size} keys found in the sources`);
    for (const key of used) {
        assert.ok(typeof en[key] === "string" && en[key].length > 0, `en misses ${key}`);
        assert.ok(typeof ro[key] === "string" && ro[key].length > 0, `ro misses ${key}`);
    }
    // No dead keys: everything in the catalogue is asked for somewhere.
    for (const key of Object.keys(en)) assert.ok(used.has(key), `${key} is in the catalogue but nothing uses it`);
    // A sentence copied from English into the Romanian table would pass the parity test.
    for (const key of Object.keys(en)) {
        if (key === "setlog.button" || key === "setlog.deck") continue; // "Tracklist", "Deck {deck}": the same word in both
        assert.notEqual(en[key], ro[key], `${key} is the same text in en and ro`);
    }
    // Romanian counted nouns: three different forms.
    assert.equal(new Set([ro["setlog.tracksN.one"], ro["setlog.tracksN.few"], ro["setlog.tracksN.other"]]).size, 3);
    assert.match(ro["setlog.tracksN.other"]!, /\{n\} de piese/);
    // Variables match between the languages.
    for (const key of Object.keys(en)) {
        const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        assert.deepEqual(vars(ro[key]!), vars(en[key]!), `${key}: variables differ`);
    }
});

test("the texts say what the DJ has to do by hand, and never call the feature AI", () => {
    for (const lang of ["en", "ro"] as const) {
        const m = setlogMessages[lang] as Record<string, string>;
        for (const [key, text] of Object.entries(m)) {
            // Case-sensitive for the abbreviation: Romanian has the words "ai" and "ia", and "aplicația" ends in "ia".
            assert.doesNotMatch(text, /(^|[^\p{L}])(AI|IA)($|[^\p{L}])/u, `${lang} ${key}`);
            assert.doesNotMatch(text, /artificial|inteligen/i, `${lang} ${key}`);
        }
        assert.match(m["setlog.uploadHint"]!, /WAV/);
        assert.match(m["setlog.clip.ok"]!, /WAV/);
        assert.match(m["setlog.empty"]!, /20/);
    }
    assert.match(setlogMessages.en["setlog.uploadHint"], /paste/i);
    assert.match(setlogMessages.ro["setlog.uploadHint"], /lipește/i);
    assert.match(setlogMessages.en["setlog.copyFailed"], /could not be copied/i);
    assert.match(setlogMessages.ro["setlog.copyFailed"], /nu a putut fi copiat/i);
});
