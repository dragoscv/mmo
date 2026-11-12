/**
 * "{n} beat(s)" texts of the deck tabs in the plural form the language asks for (English: one /
 * other; Romanian: "1 bătaie", "2 bătăi", "20 de bătăi"). Same mechanism as the track count of the
 * library and the bars of the Copilot: one catalogue key per plural form, picked by
 * `pluralCategory` (see `beatsPlural` in ./tab-math.ts).
 */
import { useCallback } from "react";
import { useLocale, useT } from "@/i18n";
import { beatsPlural } from "./tab-math";

/** Catalogue keys that exist as `<key>.one` / `<key>.few` / `<key>.other` with a `{n}` beat count. */
export type BeatsKey = "decktabs.cueLoop" | "decktabs.loopOnState" | "decktabs.beatLoop" | "decktabs.muteFxBeat";

/** `(key, label)` → the sentence for a beat count as it is shown (`1/2`, `1`, `4`, `3.5`). */
export function useBeatsText(): (key: BeatsKey, label: string) => string {
    const t = useT();
    const locale = useLocale();
    return useCallback((key, label) => t(`${key}.${beatsPlural(label, locale)}`, { n: label }), [t, locale]);
}
