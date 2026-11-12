// Run: node --test apps/mixai/src/copilot/texts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SafetyWarning } from "../bridge/copilot.ts";
import { copilotMessages } from "../i18n/messages-copilot.ts";
import { countKey, countText, pluralForm, slotCandidates, urgentKey, warningText, type CountKind } from "./texts.ts";

type Locale = "en" | "ro";
const KINDS: readonly CountKind[] = ["bars", "beats", "commands", "warnings", "tracks"];

/** The app's `t()` for one locale, on the real catalogue (`{name}` variables). */
function say(locale: Locale) {
    return (key: string, vars: Record<string, string | number> = {}): string => {
        const text = (copilotMessages[locale] as Record<string, string>)[key];
        assert.ok(text !== undefined, `${key} missing in ${locale}`);
        return text.replace(/\{(\w+)\}/g, (_, name: string) => {
            assert.ok(name in vars, `${key}: variable {${name}} was not given`);
            return String(vars[name]);
        });
    };
}

const count = (locale: Locale) => (kind: CountKind, n: number) => countText(say(locale), locale, kind, n, (v) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(v));

test("Romanian plurals: 1 bătaie, 2 bătăi, 20 de bătăi (de from 20 up, except numbers ending in 01-19)", () => {
    const ro = count("ro");
    const cases: [number, string][] = [
        [0, "0 bătăi"],
        [1, "1 bătaie"],
        [2, "2 bătăi"],
        [8, "8 bătăi"],
        [16, "16 bătăi"],
        [19, "19 bătăi"],
        [20, "20 de bătăi"],
        [21, "21 de bătăi"],
        [32, "32 de bătăi"],
        [64, "64 de bătăi"],
        [100, "100 de bătăi"],
        [101, "101 bătăi"],
        [112, "112 bătăi"],
        [119, "119 bătăi"],
        [120, "120 de bătăi"],
        [1.5, "1,5 bătăi"],
    ];
    for (const [n, want] of cases) assert.equal(ro("beats", n), want, String(n));
    assert.equal(ro("bars", 1), "1 măsură");
    assert.equal(ro("bars", 6.5), "6,5 măsuri");
    assert.equal(ro("bars", 16), "16 măsuri");
    assert.equal(ro("bars", 32), "32 de măsuri");
    assert.equal(ro("commands", 1), "1 comandă");
    assert.equal(ro("commands", 3), "3 comenzi");
    assert.equal(ro("commands", 20), "20 de comenzi");
    assert.equal(ro("warnings", 1), "1 avertisment");
    assert.equal(ro("warnings", 2), "2 avertismente");
    assert.equal(ro("tracks", 1), "1 piesă");
    assert.equal(ro("tracks", 11), "11 piese");
    assert.equal(ro("tracks", 30000), "30.000 de piese");
});

test("English plurals: 1 beat, 2 beats", () => {
    const en = count("en");
    assert.equal(en("beats", 1), "1 beat");
    assert.equal(en("beats", 0), "0 beats");
    assert.equal(en("beats", 2), "2 beats");
    assert.equal(en("beats", 20), "20 beats");
    assert.equal(en("bars", 1), "1 bar");
    assert.equal(en("bars", 1.5), "1.5 bars");
    assert.equal(en("commands", 1), "1 command");
    assert.equal(en("warnings", 3), "3 warnings");
    assert.equal(en("tracks", 30000), "30,000 tracks");
});

test("the plural form agrees with the digits on screen (rounded to one decimal first)", () => {
    // 1.04 is shown as "1": it must read "1 bar" / "1 măsură", not "1 bars" / "1 măsuri".
    assert.equal(count("en")("bars", 1.04), "1 bar");
    assert.equal(count("ro")("bars", 1.04), "1 măsură");
    assert.equal(count("ro")("bars", 19.96), "20 de măsuri");
    assert.equal(count("en")("beats", Number.NaN), "0 beats");
    assert.equal(pluralForm(1, "ro"), "one");
    assert.equal(pluralForm(2, "ro"), "few");
    assert.equal(pluralForm(20, "ro"), "other");
    assert.equal(pluralForm(1, "en"), "one");
    assert.equal(pluralForm(2, "en"), "other");
    assert.equal(pluralForm(1, "not a locale !!"), "one", "an unknown locale falls back, never throws");
    assert.equal(countKey("beats", 20, "ro"), "copilot.beatsN.other");
});

test("every counted noun has its three forms in both languages, and no message hard-codes a counted noun", () => {
    for (const locale of ["en", "ro"] as const) {
        const cat = copilotMessages[locale] as Record<string, string>;
        for (const kind of KINDS) {
            for (const form of ["one", "few", "other"]) {
                const text = cat[`copilot.${kind}N.${form}`];
                assert.ok(text?.includes("{n}"), `${locale} copilot.${kind}N.${form}`);
            }
            // Romanian: "de" only in the `other` form.
            if (locale === "ro") {
                assert.match(cat[`copilot.${kind}N.other`]!, /^\{n\} de /, kind);
                assert.doesNotMatch(cat[`copilot.${kind}N.few`]!, / de /, kind);
                assert.doesNotMatch(cat[`copilot.${kind}N.one`]!, / de /, kind);
            }
        }
        // A number variable right before a noun it counts is the bug ("{beats} bătăi", "{n} commands"):
        // outside the *N keys a counted noun arrives as finished text in its variable.
        const nouns = locale === "ro" ? /\{\w+\}\s+(de\s+)?(bătăi|bătaie|măsuri|măsură|comenzi|comandă|avertismente|avertisment|piese|piesă)\b/ : /\{\w+\}\s+(beats?|bars?|commands?|warnings?|tracks?)\b/;
        for (const [key, text] of Object.entries(cat)) {
            if (/N\.(one|few|other)$/.test(key)) continue;
            assert.doesNotMatch(text, nouns, `${locale} ${key}: "${text}"`);
        }
    }
    // The messages that count something, with the real catalogue, both ends of the plural.
    const ro = say("ro");
    const en = say("en");
    assert.equal(ro("copilot.waiting", { beats: count("ro")("beats", 1) }), "Se așteaptă fraza: 1 bătaie");
    assert.equal(ro("copilot.waiting", { beats: count("ro")("beats", 32) }), "Se așteaptă fraza: 32 de bătăi");
    assert.equal(en("copilot.waiting", { beats: count("en")("beats", 1) }), "Waiting for the phrase: 1 beat");
    assert.equal(ro("copilot.did.loop", { deck: "B", beats: count("ro")("beats", 1) }), "Deck B: buclă de 1 bătaie");
    assert.equal(ro("copilot.did.loop", { deck: "B", beats: count("ro")("beats", 8) }), "Deck B: buclă de 8 bătăi");
    assert.equal(en("copilot.did.loop", { deck: "B", beats: count("en")("beats", 1) }), "Deck B: loop of 1 beat");
    assert.equal(en("copilot.runDoneErrors", { commands: count("en")("commands", 1) }), "Transition finished; the engine refused 1 command");
    assert.equal(ro("copilot.runDoneErrors", { commands: count("ro")("commands", 1) }), "Tranziție încheiată; motorul a refuzat 1 comandă");
    assert.equal(en("copilot.buttonWarnings", { warnings: count("en")("warnings", 1) }), "1 warning");
    assert.equal(ro("copilot.buttonWarnings", { warnings: count("ro")("warnings", 2) }), "2 avertismente");
    // The pool note: "the first 2 000 of 30 000 tracks".
    assert.equal(en("copilot.poolPartial", { n: "2,000", tracks: count("en")("tracks", 30000) }), "Searched the first 2,000 of 30,000 tracks: narrow the library list to search the rest");
    assert.equal(ro("copilot.poolPartial", { n: "2.000", tracks: count("ro")("tracks", 30000) }), "S-a căutat în primele 2.000 din 30.000 de piese: restrânge lista din bibliotecă pentru a căuta și în rest");
});

test("safety warnings read with the right plural", () => {
    const num = (n: number) => String(n);
    const w = (x: Partial<SafetyWarning> & Pick<SafetyWarning, "code">): SafetyWarning => ({ severity: 1, ...x });
    assert.equal(warningText(say("en"), w({ code: "ending_without_next", barsLeft: 1 }), count("en"), num), "The track ends in 1 bar and nothing is ready");
    assert.equal(warningText(say("ro"), w({ code: "ending_without_next", barsLeft: 1 }), count("ro"), num), "Piesa se termină în 1 măsură și nu e nimic pregătit");
    assert.equal(warningText(say("ro"), w({ code: "ending_without_next", barsLeft: 24 }), count("ro"), num), "Piesa se termină în 24 de măsuri și nu e nimic pregătit");
    assert.equal(warningText(say("en"), w({ code: "plan_does_not_fit", needed: 16, barsLeft: 1 }), count("en"), num), "The plan needs 16 bars, only 1 bar left");
    assert.equal(warningText(say("ro"), w({ code: "plan_does_not_fit", needed: 32, barsLeft: 6.5 }), count("ro"), num), "Planul are nevoie de 32 de măsuri, au rămas doar 6,5 măsuri");
    assert.equal(warningText(say("en"), w({ code: "tempo_gap", percent: 7.5 }), count("en"), num), "Tempo gap to the next track: 7.5%");
    assert.equal(warningText(say("en"), w({ code: "key_clash", from: "8A", to: "2B" }), count("en"), num), "Key clash with the next track: 8A to 2B");
    assert.equal(warningText(say("en"), w({ code: "loudness_jump", deltaLu: 4 }), count("en"), num), "Loudness jump to the next track: +4 LU");
    assert.equal(warningText(say("en"), w({ code: "loudness_jump", deltaLu: -6 }), count("en"), num), "Loudness jump to the next track: -6 LU");
    assert.equal(warningText(say("en"), w({ code: "no_grid" }), count("en"), num), "No beatgrid on the playing track");
});

test("the assertive announcement follows the SET of urgent warnings, not their numbers", () => {
    const end = (barsLeft: number, severity: 1 | 2): SafetyWarning => ({ code: "ending_without_next", severity, barsLeft });
    assert.equal(urgentKey([]), "");
    assert.equal(urgentKey([end(20, 1)]), "", "a heads-up is not urgent");
    assert.equal(urgentKey([end(8, 2)]), "ending_without_next");
    // The count-down changes the sentence every two seconds: the key (what triggers speech) stays.
    assert.equal(urgentKey([end(7.5, 2)]), urgentKey([end(3, 2)]));
    assert.equal(urgentKey([{ code: "plan_does_not_fit", severity: 2 }, { code: "tempo_gap", severity: 1 }, end(4, 2)]), "plan_does_not_fit,ending_without_next");
});

test("focus goes to the control that replaced the focused one", () => {
    // Mix next -> Go -> Cancel -> Mix next all sit in the same slot.
    assert.deepEqual(slotCandidates("mix", 5), ["mix", "ask"]);
    // Discard is gone with the plan: the main button of the section.
    assert.deepEqual(slotCandidates("mix2", 5), ["mix2", "mix", "ask"]);
    // A row left the list: the same column of the nearest row, then the row's first button, then the field.
    assert.deepEqual(slotCandidates("row:2:1", 8), ["row:2:1", "row:2:0", "ask"]);
    assert.deepEqual(slotCandidates("row:7:1", 3), ["row:2:1", "row:2:0", "ask"]);
    assert.deepEqual(slotCandidates("row:0:0", 0), ["ask"]);
    // The request was cleared: the field it was typed in.
    assert.deepEqual(slotCandidates("request", 4), ["request", "ask"]);
    // Every answer ends in the field, which is always there: focus never has nowhere to go.
    for (const slot of ["mix", "mix2", "request", "row:1:0", "ask", "something-new"]) assert.equal(slotCandidates(slot, 2).at(-1), "ask", slot);
});

test("nothing the user reads calls the helper AI, and the Romanian wording is consistent", () => {
    // The abbreviation as a word of its own, in capitals ("AI", "A.I.", Romanian "IA"). `\b` is
    // ASCII-only in JavaScript ("tranziția" would match "ia" after the ț), so the boundaries are
    // spelled with Unicode letter classes.
    const abbreviation = /(?:^|[^\p{L}\p{N}])(?:AI|A\.I\.?|IA)(?=$|[^\p{L}\p{N}])/u;
    const words = /artificial|inteligen|machine learning|neural|\bmodel/i;
    assert.match("the AI picks", abbreviation);
    assert.match("asistent IA.", abbreviation);
    assert.doesNotMatch("tranziția s-a încheiat", abbreviation);
    assert.doesNotMatch("Aia e", abbreviation);
    for (const locale of ["en", "ro"] as const) {
        for (const [key, text] of Object.entries(copilotMessages[locale])) {
            assert.doesNotMatch(text, abbreviation, `${locale} ${key}: "${text}"`);
            assert.doesNotMatch(text, words, `${locale} ${key}: "${text}"`);
        }
    }
    const ro = Object.entries(copilotMessages.ro);
    // Majority spelling of the other catalogues: "stem-uri", "deck-ul / deck-urile"; "în redare", not "cântă".
    for (const [key, text] of ro) {
        assert.doesNotMatch(text, /\bstemuri|\bstemurile/i, `${key}: use "stem-uri"`);
        assert.doesNotMatch(text, /\bdeckul|\bdeckuri|\bdeckurile/i, `${key}: use "deck-ul / deck-urile"`);
        assert.doesNotMatch(text, /\bcântă\b|\bcanta\b/i, `${key}: use "în redare"`);
        assert.doesNotMatch(text, /constructor de set/i, `${key}: use "generator de set"`);
    }
    assert.match(copilotMessages.ro["copilot.buttonAria"], /generator de set/);
});
