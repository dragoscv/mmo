import { useT } from "@/i18n";
import { BleMidiSection } from "../sections/BleMidiSection";
import { HidSection } from "../sections/HidSection";
import { MidiSection } from "../sections/MidiSection";
import { Section } from "../sections/shared";

export function ControllersTab() {
    const t = useT();
    return (
        <div className="grid gap-6">
            <Section title={t("settings.midi")} settingId="controllers.midi">
                <MidiSection />
            </Section>
            <Section title={t("settings.ble")} settingId="controllers.ble">
                <BleMidiSection />
            </Section>
            <Section title={t("settings.hid")} settingId="controllers.hid">
                <HidSection />
            </Section>
        </div>
    );
}
