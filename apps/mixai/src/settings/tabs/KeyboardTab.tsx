import { Keyboard } from "lucide-react";
import { Button, Kbd } from "@mmo/ui";
import { useT, type MessageKey } from "@/i18n";
import { useUiStore } from "@/state/ui-store";
import { useKeybindStore } from "@/state/keybind-store";
import { ALL_SHORTCUTS, shortcutId, type ShortcutAction } from "@/lib/shortcuts";
import type { DeckId } from "@/bridge/types";
import { Section } from "../sections/shared";

/** Display label of a `KeyboardEvent.code` (`KeyQ` -> `Q`). */
function codeLabel(code: string): string {
    const named: Record<string, string> = { Semicolon: ";", Comma: ",", Period: ".", Slash: "?", ArrowLeft: "←", ArrowRight: "→", ArrowDown: "↓", Space: "Space" };
    return named[code] ?? code.replace(/^(Key|Digit)/, "");
}

export function KeyboardTab() {
    const t = useT();
    const overrides = useKeybindStore((s) => s.overrides);
    const key = (action: ShortcutAction, deck: DeckId | null, arg?: number) => {
        const s = ALL_SHORTCUTS.find((x) => x.action === action && x.deck === deck && (arg === undefined || x.arg === arg));
        if (!s) return "";
        return codeLabel(overrides[shortcutId(s)] ?? s.code);
    };
    const rows: { label: MessageKey; keys: string[] }[] = [
        { label: "settings.keyPlayA", keys: [key("play", "a")] },
        { label: "settings.keyPlayB", keys: [key("play", "b")] },
        { label: "settings.keyCueA", keys: [key("cue", "a")] },
        { label: "settings.keyCueB", keys: [key("cue", "b")] },
        { label: "settings.keyCrossfade", keys: [key("crossfaderTo", null, -1), key("crossfaderTo", null, 1)] },
        { label: "settings.keySnapshots", keys: ["Alt", "1…8"] },
        { label: "settings.keySettings", keys: ["Ctrl", ","] },
        { label: "settings.keyHelp", keys: [key("toggleHelp", null)] },
    ];

    const openOverlay = () => {
        const ui = useUiStore.getState();
        ui.setSettingsOpen(false);
        ui.setShortcutsOpen(true);
    };

    return (
        <div className="grid gap-6">
            <Section title={t("settings.keyboardTitle")} settingId="keyboard.shortcuts">
                <p className="text-xs text-muted-foreground">{t("settings.keyboardHint")}</p>
                <dl className="grid gap-1">
                    {rows.map((r) => (
                        <div key={r.label} className="flex items-center justify-between gap-4 rounded-md bg-muted/40 px-3 py-1.5 text-sm">
                            <dt>{t(r.label)}</dt>
                            <dd className="flex items-center gap-1">
                                {r.keys.filter(Boolean).map((k, i) => (
                                    <Kbd key={`${k}-${i}`}>{k}</Kbd>
                                ))}
                            </dd>
                        </div>
                    ))}
                </dl>
                <div>
                    <Button variant="outline" size="sm" onClick={openOverlay}>
                        <Keyboard aria-hidden /> {t("settings.keyboardOpen")}
                    </Button>
                </div>
            </Section>
        </div>
    );
}
