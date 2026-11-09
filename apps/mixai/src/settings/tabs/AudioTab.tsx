import { useEffect, useState } from "react";
import { engine } from "@/bridge/engine";
import type { AudioDevice } from "@/bridge/types";
import { useT } from "@/i18n";
import { DeviceSelect } from "../sections/DeviceSelect";
import { LatencySection } from "../sections/LatencySection";
import { Section } from "../sections/shared";

export function AudioTab() {
    const t = useT();
    const [devices, setDevices] = useState<AudioDevice[]>([]);

    useEffect(() => {
        void (async () => {
            const d = await engine.listAudioDevices();
            if (d) setDevices(d);
        })();
    }, []);

    return (
        <div className="grid gap-6">
            <Section title={t("settings.audioOut")} settingId="audio.master">
                <DeviceSelect devices={devices} label={t("settings.audioOut")} onChange={(id) => void engine.setOutputDevice(id)} />
            </Section>
            <Section title={t("settings.cueOut")} settingId="audio.cue">
                <DeviceSelect devices={devices} label={t("settings.cueOut")} onChange={(id) => void engine.setCueDevice(id)} />
            </Section>
            <Section title={t("settings.latency")} settingId="audio.latency">
                <LatencySection />
            </Section>
        </div>
    );
}
