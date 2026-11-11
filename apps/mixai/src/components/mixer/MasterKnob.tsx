import { engine } from "@/bridge/engine";
import { useMixerStore } from "@/state/mixer-store";
import { useT } from "@/i18n";
import { Knob } from "../Knob";

export const pct = (v: number) => `${Math.round(v * 100)}%`;

export function setMasterVolume(v: number): void {
    useMixerStore.getState().patchMixer({ masterVolume: v });
    void engine.setMasterVolume(v);
}

/** Master volume (0..100 %, double click = 100 %). Shown by the mixer's master column, or by the crossfader panel when no mixer is on screen. */
export function MasterKnob({ size, label = false, showValue = false }: { size: number; label?: boolean; showValue?: boolean }) {
    const t = useT();
    const v = useMixerStore((s) => s.masterVolume);
    return (
        <Knob
            size={size}
            value={v}
            min={0}
            max={1}
            center={1}
            label={label ? t("deckui.master") : undefined}
            ariaLabel={t("deckui.masterAria")}
            format={pct}
            showValue={showValue}
            onChange={setMasterVolume}
        />
    );
}
