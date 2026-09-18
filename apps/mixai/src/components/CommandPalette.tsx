import { useEffect, useMemo } from "react";
import { Circle, Keyboard, LayoutGrid, Layers, Moon, Settings, Square, Sun } from "lucide-react";
import { CommandDialog, useCommandPalette, type CommandItemDef } from "@mmo/ui";
import { useThemePrefs } from "@mmo/ui/theme";
import { useUiStore } from "@/state/ui-store";
import { useMixerStore } from "@/state/mixer-store";
import { useRecordingStore } from "@/state/recording-store";
import { useT } from "@/i18n";

/**
 * Global command palette (Ctrl/⌘ K). Navigation + actions + theme quick
 * switches. Open state is mirrored into the ui-store so the TopBar button and
 * the shortcut share one source of truth.
 */
export function CommandPalette() {
    const t = useT();
    const { open, setOpen } = useCommandPalette({ label: t("topbar.commands"), group: "general" });
    const commandOpen = useUiStore((s) => s.commandOpen);
    const setCommandOpen = useUiStore((s) => s.setCommandOpen);
    const deckCount = useUiStore((s) => s.deckCount);
    const setDeckCount = useUiStore((s) => s.setDeckCount);
    const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
    const setShortcutsOpen = useUiStore((s) => s.setShortcutsOpen);
    const native = useMixerStore((s) => s.native);
    const recording = useRecordingStore((s) => s.recording);
    const toggleRecording = useRecordingStore((s) => s.toggle);
    const { prefs, setPrefs, resolvedMode } = useThemePrefs();

    // TopBar button → palette
    useEffect(() => {
        if (commandOpen) {
            setOpen(true);
            setCommandOpen(false);
        }
    }, [commandOpen, setOpen, setCommandOpen]);

    const items = useMemo<CommandItemDef[]>(
        () => [
            {
                id: "decks",
                group: "navigate",
                label: deckCount === 4 ? t("command.toggleDecks2") : t("command.toggleDecks4"),
                icon: deckCount === 4 ? <Layers aria-hidden /> : <LayoutGrid aria-hidden />,
                keywords: ["deck", "layout", "2", "4"],
                onSelect: () => setDeckCount(deckCount === 4 ? 2 : 4),
            },
            {
                id: "settings",
                group: "navigate",
                label: t("command.openSettings"),
                icon: <Settings aria-hidden />,
                keywords: ["settings", "setari", "preferences"],
                onSelect: () => setSettingsOpen(true),
            },
            {
                id: "shortcuts",
                group: "navigate",
                label: t("command.shortcuts"),
                icon: <Keyboard aria-hidden />,
                shortcut: ["?"],
                onSelect: () => setShortcutsOpen(true),
            },
            {
                id: "record",
                group: "actions",
                label: t("command.record"),
                icon: recording ? <Square aria-hidden /> : <Circle aria-hidden />,
                keywords: ["rec", "record", "wav", "inregistrare"],
                disabled: !native,
                onSelect: () => void toggleRecording(),
            },
            {
                id: "mode",
                group: "theme",
                label: t("command.toggleMode"),
                icon: resolvedMode === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />,
                keywords: ["light", "dark", "theme", "luminos", "intunecat"],
                onSelect: () => setPrefs({ mode: resolvedMode === "dark" ? "light" : "dark" }),
            },
            {
                id: "surface-glass",
                group: "theme",
                label: t("command.surfaceGlass"),
                disabled: prefs.surface === "glass",
                onSelect: () => setPrefs({ surface: "glass" }),
            },
            {
                id: "surface-solid",
                group: "theme",
                label: t("command.surfaceSolid"),
                disabled: prefs.surface === "solid",
                onSelect: () => setPrefs({ surface: "solid" }),
            },
            {
                id: "surface-flat",
                group: "theme",
                label: t("command.surfaceFlat"),
                disabled: prefs.surface === "flat",
                onSelect: () => setPrefs({ surface: "flat" }),
            },
        ],
        [deckCount, native, prefs.surface, recording, resolvedMode, setDeckCount, setPrefs, setSettingsOpen, setShortcutsOpen, t, toggleRecording],
    );

    return <CommandDialog open={open} onOpenChange={setOpen} items={items} placeholder={t("command.placeholder")} />;
}
