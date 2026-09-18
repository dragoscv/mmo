import { useEffect, useState } from "react";
import { getLocale, setLocale as persistLocale, LOCALE_EVENT, type Locale } from "./messages";

/** `[locale, setLocale]` — `setLocale` persists to the shared prefs blob and broadcasts `mixai:locale`. */
export function useLocale(): [Locale, (l: Locale) => void] {
    const [locale, set] = useState<Locale>(() => getLocale());
    useEffect(() => {
        const onChange = (e: Event) => {
            const d = (e as CustomEvent<Locale>).detail;
            set(d === "en" || d === "ro" ? d : getLocale());
        };
        window.addEventListener(LOCALE_EVENT, onChange);
        return () => window.removeEventListener(LOCALE_EVENT, onChange);
    }, []);
    return [locale, persistLocale];
}
