import { useEffect, useMemo } from "react";
import { Circle, Keyboard, LayoutGrid, Layers, ListMusic, Lock, LockOpen, Moon, Settings, Square, Sun } from "lucide-react";
import { CommandDialog, useCommandPalette, type CommandItemDef } from "@mmo/ui";
import { useThemePrefs } from "@mmo/ui/theme";
import { useUiStore } from "@/state/ui-store";
import { useMixerStore } from "@/state/mixer-store";
import { useRecordingStore } from "@/state/recording-store";
import { useSetlogStore } from "@/setlog/setlog-store";
import { gigAllows, useGigStore } from "@/gig/gig-store";
import { useT } from "@/i18n";

/**
 * A palette item that changes a setting (deck count, theme mode, surface). Gig lock: the
 * palette is a door to settings beside the Settings modal, so these ask the same gate; while
 * locked nothing changes and the gate says why in the status region.
 */
function change(run: () => void): () => void {
    return () => {
        if (!gigAllows("changeSettings")) return;
        run();
    };
}

/**
 * Global command palette (Ctrl/⌘ K). Navigation + actions + theme quick
 * switches. Open state is mirrored into the ui-store so the title bar button and
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
    const gigLocked = useGigStore((s) => s.locked);
    const { prefs, setPrefs, resolvedMode } = useThemePrefs();

    // title bar button → palette
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
                onSelect: change(() => setDeckCount(deckCount === 4 ? 2 : 4)),
            },
            {
                id: "settings",
                group: "navigate",
                // Gig lock: the item stays selectable; selecting it says why Settings stay closed (ui-store asks the gate).
                label: gigLocked ? t("gig.commandLocked") : t("command.openSettings"),
                icon: gigLocked ? <Lock aria-hidden /> : <Settings aria-hidden />,
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
                id: "setlog",
                group: "actions",
                label: t("setlog.command"),
                icon: <ListMusic aria-hidden />,
                keywords: ["tracklist", "mixcloud", "upload", "set", "piese", "incarca"],
                disabled: !native,
                // After the palette has closed and handed the focus back: the popover then takes it.
                onSelect: () => window.setTimeout(() => useSetlogStore.getState().setOpen(true), 0),
            },
            {
                id: "gig",
                group: "actions",
                label: t("gig.command"),
                icon: gigLocked ? <Lock aria-hidden /> : <LockOpen aria-hidden />,
                keywords: ["gig", "lock", "unlock", "set", "checklist", "blocare", "deblocare", "verificari", "concert"],
                shortcut: ["mod+shift+g"],
                // Opens the popover (never toggles: unlocking stays the two-step in there). After the
                // palette has closed and handed the focus back: the popover then takes it.
                onSelect: () => window.setTimeout(() => useGigStore.getState().setOpen(true), 0),
            },
            {
                id: "mode",
                group: "theme",
                label: t("command.toggleMode"),
                icon: resolvedMode === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />,
                keywords: ["light", "dark", "theme", "luminos", "intunecat"],
                onSelect: change(() => setPrefs({ mode: resolvedMode === "dark" ? "light" : "dark" })),
            },
            {
                id: "surface-glass",
                group: "theme",
                label: t("command.surfaceGlass"),
                disabled: prefs.surface === "glass",
                onSelect: change(() => setPrefs({ surface: "glass" })),
            },
            {
                id: "surface-solid",
                group: "theme",
                label: t("command.surfaceSolid"),
                disabled: prefs.surface === "solid",
                onSelect: change(() => setPrefs({ surface: "solid" })),
            },
            {
                id: "surface-flat",
                group: "theme",
                label: t("command.surfaceFlat"),
                disabled: prefs.surface === "flat",
                onSelect: change(() => setPrefs({ surface: "flat" })),
            },
        ],
        [deckCount, gigLocked, native, prefs.surface, recording, resolvedMode, setDeckCount, setPrefs, setSettingsOpen, setShortcutsOpen, t, toggleRecording],
    );

    return <CommandDialog open={open} onOpenChange={setOpen} items={items} placeholder={t("command.placeholder")} />;
}
