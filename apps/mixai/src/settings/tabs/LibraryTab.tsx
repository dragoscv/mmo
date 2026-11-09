import { useT } from "@/i18n";
import { CompanionSection } from "../sections/CompanionSection";
import { Section } from "../sections/shared";

export function LibraryTab() {
    const t = useT();
    return (
        <div className="grid gap-6">
            <Section title={t("settings.library")} settingId="library.companion">
                <CompanionSection />
            </Section>
        </div>
    );
}
