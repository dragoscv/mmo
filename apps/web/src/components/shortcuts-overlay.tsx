"use client";

/** Press `?` to toggle the keyboard-shortcuts cheat sheet.
 *  Built on @mmo/ui's registry + ShortcutsOverlay; mounted once in the root layout.
 *
 *  The playback/navigation shortcuts below are HANDLED by the player and the
 *  route components themselves — they are registered here documentation-only
 *  (`when: () => false`) so the overlay lists them without double-firing. */

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { ShortcutsOverlay as UiShortcutsOverlay, registerShortcut, useInstallShortcutListener, useShortcutsOverlay } from "@mmo/ui";

type Doc = { id: string; keys: string[]; group: "playback" | "navigation" | "help"; label: string };

const never = () => false;
const noop = () => {};

export function ShortcutsOverlay() {
    const t = useTranslations("shortcuts");
    useInstallShortcutListener();
    const { open, setOpen } = useShortcutsOverlay();

    useEffect(() => {
        const docs: Doc[] = [
            { id: "doc-play-pause", keys: ["space"], group: "playback", label: t("playPause") },
            { id: "doc-seek-back", keys: ["left"], group: "playback", label: t("seekBack") },
            { id: "doc-seek-forward", keys: ["right"], group: "playback", label: t("seekForward") },
            { id: "doc-back-10", keys: ["j"], group: "playback", label: t("back10") },
            { id: "doc-forward-10", keys: ["l"], group: "playback", label: t("forward10") },
            { id: "doc-pause-resume", keys: ["k"], group: "playback", label: t("pauseResume") },
            { id: "doc-mute", keys: ["m"], group: "playback", label: t("mute") },
            { id: "doc-fullscreen", keys: ["f"], group: "playback", label: t("fullscreen") },
            { id: "doc-pip", keys: ["p"], group: "playback", label: t("pip") },
            { id: "doc-skip-intro", keys: ["n"], group: "playback", label: t("skipIntro") },
            { id: "doc-now-playing", keys: ["shift+n"], group: "navigation", label: t("nowPlaying") },
            { id: "doc-go-library", keys: ["g l"], group: "navigation", label: t("library") },
            { id: "doc-go-watch", keys: ["g w"], group: "navigation", label: t("watch") },
            { id: "doc-go-stats", keys: ["g s"], group: "navigation", label: t("stats") },
            { id: "doc-search", keys: ["/"], group: "navigation", label: t("search") },
            { id: "doc-close-overlays", keys: ["esc"], group: "help", label: t("closeOverlays") },
        ];
        const offs = docs.map((d) => registerShortcut({ ...d, handler: noop, when: never }));
        return () => offs.forEach((off) => off());
    }, [t]);

    return (
        <UiShortcutsOverlay
            open={open}
            onOpenChange={setOpen}
            groupLabels={{
                playback: t("groups.playback"),
                navigation: t("groups.navigation"),
                help: t("groups.help"),
                general: t("groups.help"),
            }}
        />
    );
}
