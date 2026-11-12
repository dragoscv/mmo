/**
 * Text helpers of the co-pilot that need no DOM and no store (tested with
 * `node --test texts.test.ts`): counted nouns with the right plural form, the safety warning
 * sentences, and where keyboard focus goes when the focused control is replaced.
 */
import type { SafetyWarning } from "../bridge/copilot.ts";

/** What a number in a co-pilot message counts. Each has three catalogue forms: `copilot.<kind>N.one|few|other`. */
export type CountKind = "bars" | "beats" | "commands" | "warnings" | "tracks";
export type PluralForm = "one" | "few" | "other";
export type CountKey = `copilot.${CountKind}N.${PluralForm}`;

/**
 * Plural form of `n` in `locale`, folded to the three forms the catalogue has. Romanian: 1 is
 * `one` ("1 bătaie"); 0, 2..19, every number ending in 01..19 and every fraction are `few`
 * ("2 bătăi", "101 bătăi", "1,5 bătăi"); the rest are `other`, which takes "de" ("20 de bătăi").
 * English: 1 is `one`, everything else `other`.
 */
export function pluralForm(n: number, locale: string): PluralForm {
    let category: string;
    try {
        category = new Intl.PluralRules(locale).select(Number.isFinite(n) ? n : 0);
    } catch {
        category = n === 1 ? "one" : "other";
    }
    return category === "one" ? "one" : category === "few" ? "few" : "other";
}

/** Catalogue key of "`n` things" (the text takes `{n}`). */
export function countKey(kind: CountKind, n: number, locale: string): CountKey {
    return `copilot.${kind}N.${pluralForm(n, locale)}`;
}

/** The translate function, as far as these helpers need it. */
export type Say<K extends string> = (key: K, vars?: Record<string, string | number>) => string;

/**
 * "`n` things" as text: the number is rounded to one decimal FIRST, so the plural form agrees
 * with the digits on screen (1.04 is shown as "1" and reads "1 bar", not "1 bars").
 */
export function countText(say: Say<CountKey>, locale: string, kind: CountKind, n: number, format: (n: number) => string): string {
    const shown = Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
    return say(countKey(kind, shown, locale), { n: format(shown) });
}

export type WarningKey =
    | "copilot.warn.ending_without_next"
    | "copilot.warn.plan_does_not_fit"
    | "copilot.warn.tempo_gap"
    | "copilot.warn.key_clash"
    | "copilot.warn.loudness_jump"
    | "copilot.warn.no_grid";

/** One safety warning as a sentence. `count` writes a counted noun ("6 bars"), `num` a plain number. */
export function warningText(t: Say<WarningKey>, w: SafetyWarning, count: (kind: CountKind, n: number) => string, num: (n: number) => string): string {
    switch (w.code) {
        case "ending_without_next":
            return t("copilot.warn.ending_without_next", { bars: count("bars", w.barsLeft ?? 0) });
        case "plan_does_not_fit":
            return t("copilot.warn.plan_does_not_fit", { needed: count("bars", w.needed ?? 0), bars: count("bars", w.barsLeft ?? 0) });
        case "tempo_gap":
            return t("copilot.warn.tempo_gap", { percent: num(w.percent ?? 0) });
        case "key_clash":
            return t("copilot.warn.key_clash", { from: w.from ?? "?", to: w.to ?? "?" });
        case "loudness_jump":
            return t("copilot.warn.loudness_jump", { lu: `${(w.deltaLu ?? 0) > 0 ? "+" : ""}${num(w.deltaLu ?? 0)}` });
        default:
            return t("copilot.warn.no_grid");
    }
}

/**
 * Identity of the warnings that ask for action now (severity 2): their codes, in order. The
 * assertive announcement is made when this changes, not every time a number in the sentence
 * does ("ends in 6 bars", then 5.5, then 5 would otherwise be spoken every two seconds).
 */
export function urgentKey(warnings: readonly Pick<SafetyWarning, "code" | "severity">[]): string {
    return warnings
        .filter((w) => w.severity >= 2)
        .map((w) => w.code)
        .join(",");
}

/**
 * Focus slots of the popover (`data-cp-slot`): when the focused control leaves the page (Mix
 * becomes Go, the plan is dropped, a row leaves the list, the request is cleared) focus goes to
 * the first of these that exists, instead of falling to `<body>`.
 *
 *   ask · request · row:<index>:<column> · mix (Mix / Go / Cancel) · mix2 (Discard)
 *
 * `rows` = rows in the list now. A row slot moves to the same column of the nearest row.
 */
export function slotCandidates(slot: string, rows: number): string[] {
    const m = /^row:(\d+):(\d+)$/.exec(slot);
    if (m) {
        if (rows <= 0) return ["ask"];
        const row = Math.min(Number(m[1]), rows - 1);
        return [`row:${row}:${m[2]}`, `row:${row}:0`, "ask"];
    }
    if (slot === "mix2") return ["mix2", "mix", "ask"];
    if (slot === "mix") return ["mix", "ask"];
    if (slot === "request") return ["request", "ask"];
    return [slot, "ask"];
}
