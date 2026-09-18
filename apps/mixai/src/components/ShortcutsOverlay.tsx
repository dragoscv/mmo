/**
 * Keyboard shortcuts cheat-sheet + keybind editor. Toggled with `?`, the TopBar
 * button or the command palette. Each row shows the *effective* key (default
 * or user override) and can be clicked to capture a new key. Overrides live in
 * the keybind store (persisted + profile-synced).
 *
 * The effective bindings are also mirrored into @mmo/ui's shortcut registry so
 * the shared `CommandDialog` / other surfaces can list them. Dispatch stays in
 * `lib/use-shortcuts` (it matches on `KeyboardEvent.code`, layout-independent),
 * so the registry entries are list-only (`when: () => false`).
 */

import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Kbd,
    registerShortcut,
    useInstallShortcutListener,
} from "@mmo/ui";
import { useUiStore } from "@/state/ui-store";
import { SHORTCUT_GROUPS, codeLabel, shortcutId } from "@/lib/shortcuts";
import { useKeybindStore } from "@/state/keybind-store";
import { useT, type MessageKey } from "@/i18n";

const GROUP_KEYS: Record<string, MessageKey> = {
    "Deck A": "shortcuts.group.deckA",
    "Deck B": "shortcuts.group.deckB",
    Mixer: "shortcuts.group.mixer",
};

/** Mirror the effective mixai bindings into the shared registry (list-only). */
function useMirrorShortcutsToRegistry() {
    const bindings = useKeybindStore((s) => s.bindings);
    useEffect(() => {
        const unregister: Array<() => void> = [];
        for (const [code, s] of bindings) {
            unregister.push(
                registerShortcut({
                    id: `mixai:${shortcutId(s)}`,
                    keys: [codeLabel(code).toLowerCase()],
                    label: s.label,
                    group: s.deck ? `deck-${s.deck}` : "mixer",
                    handler: () => {},
                    when: () => false,
                }),
            );
        }
        return () => unregister.forEach((u) => u());
    }, [bindings]);
}

export function ShortcutsOverlay() {
    const t = useT();
    const open = useUiStore((s) => s.shortcutsOpen);
    const setOpen = useUiStore((s) => s.setShortcutsOpen);
    const overrides = useKeybindStore((s) => s.overrides);
    const rebind = useKeybindStore((s) => s.rebind);
    const reset = useKeybindStore((s) => s.reset);
    const resetAll = useKeybindStore((s) => s.resetAll);
    const [capturing, setCapturing] = useState<string | null>(null);

    // Shared registry: install the single keydown dispatcher (mod+k etc.).
    useInstallShortcutListener();
    useMirrorShortcutsToRegistry();

    // While capturing, the next key press (sans modifiers) becomes the binding.
    useEffect(() => {
        if (!capturing) return;
        const onKey = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Escape") {
                setCapturing(null);
                return;
            }
            if (e.key === "Control" || e.key === "Alt" || e.key === "Shift" || e.key === "Meta") return;
            rebind(capturing, e.code);
            setCapturing(null);
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [capturing, rebind]);

    return (
        <Dialog
            open={open}
            onOpenChange={(o) => {
                if (!o) setCapturing(null);
                setOpen(o);
            }}
        >
            <DialogContent size="lg" className="max-h-[85dvh] overflow-hidden">
                <DialogHeader className="flex-row items-start justify-between gap-4 pr-8">
                    <div>
                        <DialogTitle>{t("shortcuts.title")}</DialogTitle>
                        <DialogDescription className="mt-1">
                            {t("shortcuts.help", { key: "?" })}
                        </DialogDescription>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        title={t("shortcuts.resetAllHint")}
                        onClick={() => {
                            setCapturing(null);
                            resetAll();
                        }}
                    >
                        <RotateCcw aria-hidden />
                        {t("shortcuts.resetAll")}
                    </Button>
                </DialogHeader>

                <div className="grid gap-4 overflow-y-auto pb-1 sm:grid-cols-3">
                    {SHORTCUT_GROUPS.map((group) => (
                        <section key={group.title} className="grid content-start gap-1">
                            <h3 className="px-1 pb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                                {t(GROUP_KEYS[group.title] ?? "shortcuts.group.general")}
                            </h3>
                            {group.items.map((s) => {
                                const id = shortcutId(s);
                                const overridden = id in overrides;
                                const effectiveCode = overrides[id] ?? s.code;
                                const isCapturing = capturing === id;
                                return (
                                    <div key={id} className="flex h-8 items-center gap-2 rounded-md px-1 text-xs hover:bg-muted/60">
                                        <button
                                            type="button"
                                            onClick={() => setCapturing(isCapturing ? null : id)}
                                            title={isCapturing ? t("shortcuts.pressKey") : t("shortcuts.rebind")}
                                            aria-pressed={isCapturing}
                                            className="focus-visible:ring-ring/40 rounded-md outline-none focus-visible:ring-3"
                                        >
                                            <Kbd
                                                size="md"
                                                className={
                                                    "pointer-events-auto cursor-pointer " +
                                                    (isCapturing
                                                        ? "border-primary bg-primary text-primary-foreground"
                                                        : overridden
                                                          ? "border-primary text-foreground"
                                                          : "text-foreground")
                                                }
                                            >
                                                {isCapturing ? "…" : codeLabel(effectiveCode)}
                                            </Kbd>
                                        </button>
                                        <span className="flex-1 truncate text-muted-foreground">{s.label}</span>
                                        {overridden && !isCapturing && (
                                            <Button
                                                variant="ghost"
                                                size="icon-xs"
                                                title={t("shortcuts.resetOne")}
                                                aria-label={t("shortcuts.resetOne")}
                                                onClick={() => reset(id)}
                                            >
                                                <RotateCcw aria-hidden />
                                            </Button>
                                        )}
                                    </div>
                                );
                            })}
                        </section>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    );
}
