/** Counted nouns in the current language: "6 bars" / "6,5 măsuri" / "20 de măsuri" (see texts.ts). */
import { useMemo } from "react";
import { useLocale, useT } from "@/i18n";
import { countText, type CountKind } from "./texts.ts";

export type Count = (kind: CountKind, n: number) => string;

export function useCount(): Count {
    const t = useT();
    const locale = useLocale();
    return useMemo(() => {
        const fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
        return (kind: CountKind, n: number) => countText(t, locale, kind, n, (v) => fmt.format(v));
    }, [t, locale]);
}
