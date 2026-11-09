import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, ThemeSettings } from "@mmo/ui";
import { useThemePrefs } from "@mmo/ui/theme";
import { useT } from "@/i18n";
import { Section } from "../sections/shared";
import { AppearanceExtras } from "./AppearanceExtras";

const LANGS = { ro: "Română", en: "English" } as const;

export function AppearanceTab() {
    const t = useT();
    const { prefs, setPrefs } = useThemePrefs();
    return (
        <div className="grid gap-6">
            <Section title={t("settings.appearance")} settingId="appearance.theme">
                <ThemeSettings hide={["locale"]} className="[&_section]:p-4" />
            </Section>
            <Section title={t("settings.language")} settingId="appearance.language">
                <Select
                    items={LANGS}
                    value={prefs.locale}
                    onValueChange={(v) => {
                        if (v === "ro" || v === "en") setPrefs({ locale: v });
                    }}
                >
                    <SelectTrigger aria-label={t("settings.language")} className="w-56">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {(Object.keys(LANGS) as (keyof typeof LANGS)[]).map((l) => (
                            <SelectItem key={l} value={l} lang={l}>
                                {LANGS[l]}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </Section>
            <div data-setting-id="appearance.extras" className="scroll-mt-4 rounded-xl data-[highlight=true]:ring-2 data-[highlight=true]:ring-ring/60">
                <AppearanceExtras />
            </div>
        </div>
    );
}
