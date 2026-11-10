/**
 * MIDI learn affordances: a small "learn" button for any control and a hook that tells whether the
 * engine is waiting for a pedal/controller for a given target (`state.midi.learning`).
 */
import { Crosshair } from "lucide-react";
import { Button, cn } from "@mmo/ui";
import { useT } from "../i18n";
import { isLearning, midiLearn, targetKey, type MidiTarget } from "../lib/protocol";
import { useStore } from "../store";

/** `{ armed, bound, toggle }` for one target: arm learn, or cancel it when already armed. */
export function useMidiLearn(target: MidiTarget) {
    const learning = useStore((s) => s.proto.state?.midi?.learning ?? null);
    const key = targetKey(target);
    const bound = useStore((s) => s.proto.state?.midi?.map.bindings.some((b) => targetKey(b.target) === key) ?? false);
    const available = useStore((s) => !!s.proto.state?.midi && s.proto.hello?.role === "controller");
    const send = useStore((s) => s.send);
    const armed = isLearning(learning, target);
    return { armed, bound, available, toggle: () => send(midiLearn(armed ? null : target)) };
}

export interface MidiLearnButtonProps {
    target: MidiTarget;
    /** Localised name of the control, used in the accessible label. */
    label: string;
    className?: string;
}

/** Tiny crosshair button; pulses while armed, tinted when a binding exists. */
export function MidiLearnButton({ target, label, className }: MidiLearnButtonProps) {
    const t = useT();
    const { armed, bound, available, toggle } = useMidiLearn(target);
    if (!available) return null;
    const text = armed ? t("midi.learnCancel") : t("midi.learnFor", { name: label });
    return (
        <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={text}
            aria-pressed={armed}
            title={text}
            onClick={toggle}
            className={cn(
                "text-muted-foreground",
                bound && "text-primary",
                armed && "animate-pulse bg-primary/20 text-primary ring-2 ring-primary/50",
                className,
            )}
        >
            <Crosshair />
        </Button>
    );
}
