/**
 * Settings modal: vertical tab rail on the left (search + 10 tabs), content
 * pane on the right (header with Reset, scrolling body, footer with Undo /
 * status / Export / Import / Close). Replaces the old right-side Sheet.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { useMotionOK } from "@/shell/motion";
import {
    Download,
    Gamepad2,
    Info,
    Keyboard,
    LayoutGrid,
    Library,
    Palette,
    Puzzle,
    RotateCcw,
    Search,
    Store,
    Undo2,
    Upload,
    UserCog,
    Volume2,
    type LucideProps,
} from "lucide-react";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    Button,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogTitle,
    Input,
    cn,
} from "@mmo/ui";
import { useThemePrefs } from "@mmo/ui/theme";
import { useT, type MessageKey } from "@/i18n";
import { SETTINGS_TABS, useUiStore, type SettingsTab } from "@/state/ui-store";
import { searchSettings, type SettingEntry } from "./search-index";
import { useSettingsSearchFocus } from "./hotkey";
import { useUndoStore } from "./undo-store";
import { TAB_SECTIONS, apply, defaultSections } from "./settings-live";
import { ExportDialog, ImportDialog, startImport, useFileDialogs } from "./SettingsFileDialogs";
import { AppearanceTab } from "./tabs/AppearanceTab";
import { LayoutTab } from "./tabs/LayoutTab";
import { AudioTab } from "./tabs/AudioTab";
import { ControllersTab } from "./tabs/ControllersTab";
import { KeyboardTab } from "./tabs/KeyboardTab";
import { LibraryTab } from "./tabs/LibraryTab";
import { PluginsTab } from "./tabs/PluginsTab";
import { MarketplaceTab } from "./tabs/MarketplaceTab";
import { ProfilesTab } from "./tabs/ProfilesTab";
import { AboutTab } from "./tabs/AboutTab";

interface TabDef {
    icon: ComponentType<LucideProps>;
    label: MessageKey;
    desc: MessageKey;
    body: ComponentType;
}

export const TAB_DEFS: Record<SettingsTab, TabDef> = {
    appearance: { icon: Palette, label: "settings.tabAppearance", desc: "settings.tabAppearanceDesc", body: AppearanceTab },
    layout: { icon: LayoutGrid, label: "settings.tabLayout", desc: "settings.tabLayoutDesc", body: LayoutTab },
    audio: { icon: Volume2, label: "settings.tabAudio", desc: "settings.tabAudioDesc", body: AudioTab },
    controllers: { icon: Gamepad2, label: "settings.tabControllers", desc: "settings.tabControllersDesc", body: ControllersTab },
    keyboard: { icon: Keyboard, label: "settings.tabKeyboard", desc: "settings.tabKeyboardDesc", body: KeyboardTab },
    library: { icon: Library, label: "settings.tabLibrary", desc: "settings.tabLibraryDesc", body: LibraryTab },
    plugins: { icon: Puzzle, label: "settings.tabPlugins", desc: "settings.tabPluginsDesc", body: PluginsTab },
    marketplace: { icon: Store, label: "settings.tabMarketplace", desc: "settings.tabMarketplaceDesc", body: MarketplaceTab },
    profiles: { icon: UserCog, label: "settings.tabProfiles", desc: "settings.tabProfilesDesc", body: ProfilesTab },
    about: { icon: Info, label: "settings.tabAbout", desc: "settings.tabAboutDesc", body: AboutTab },
};

/** True when Motion should not animate (app pref, governor or OS setting). */
function useMotionReduced(): boolean {
    const os = useReducedMotion();
    const { prefs } = useThemePrefs();
    const ok = useMotionOK();
    return Boolean(os) || prefs.motion === "reduced" || !ok;
}

function isTextTarget(el: EventTarget | null): boolean {
    if (!(el instanceof HTMLElement)) return false;
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

export function SettingsModal() {
    const t = useT();
    const open = useUiStore((s) => s.settingsOpen);
    const setOpen = useUiStore((s) => s.setSettingsOpen);
    const tab = useUiStore((s) => s.settingsTab);
    const setTab = useUiStore((s) => s.setSettingsTab);
    const reduced = useMotionReduced();
    const undoStack = useUndoStore((s) => s.stack);
    const rev = useUndoStore((s) => s.rev);
    const status = useUndoStore((s) => s.status);
    const setStatus = useUndoStore((s) => s.setStatus);
    const runUndoable = useUndoStore((s) => s.run);
    const undo = useUndoStore((s) => s.undo);
    const setExportOpen = useFileDialogs((s) => s.setExportOpen);
    const focusPending = useSettingsSearchFocus((s) => s.pending);
    const consumeFocus = useSettingsSearchFocus((s) => s.consume);

    const [query, setQuery] = useState("");
    const [resultIdx, setResultIdx] = useState(0);
    const [confirmReset, setConfirmReset] = useState(false);
    const searchRef = useRef<HTMLInputElement>(null);
    const paneRef = useRef<HTMLDivElement>(null);
    const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});
    const pendingScroll = useRef<string | null>(null);

    const tabLabel = useCallback((id: SettingsTab) => t(TAB_DEFS[id].label), [t]);
    const results = useMemo(() => searchSettings(query, (k) => t(k as MessageKey), tabLabel), [query, t, tabLabel]);
    const searching = query.trim().length > 0;

    // Ctrl+, : focus the search (on open and when re-pressed while open).
    useEffect(() => {
        if (!open || !focusPending) return;
        const id = window.setTimeout(() => {
            const el = searchRef.current;
            consumeFocus();
            if (!el || el.offsetParent === null) return; // hidden on narrow screens
            el.focus();
            el.select();
        }, 60);
        return () => window.clearTimeout(id);
    }, [open, focusPending, consumeFocus]);

    // Status line clears itself.
    useEffect(() => {
        if (!status) return;
        const id = window.setTimeout(() => setStatus(null), 4000);
        return () => window.clearTimeout(id);
    }, [status, setStatus]);

    const highlight = useCallback((id: string) => {
        const el = paneRef.current?.querySelector<HTMLElement>(`[data-setting-id="${CSS.escape(id)}"]`);
        if (!el) return false;
        el.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
        el.setAttribute("data-highlight", "true");
        window.setTimeout(() => el.removeAttribute("data-highlight"), 1600);
        return true;
    }, [reduced]);

    const jumpTo = (e: SettingEntry) => {
        setQuery("");
        setResultIdx(0);
        pendingScroll.current = e.id;
        if (e.tab === tab) {
            requestAnimationFrame(() => {
                if (pendingScroll.current && highlight(pendingScroll.current)) pendingScroll.current = null;
            });
        } else setTab(e.tab);
    };

    // After a tab switch (and its enter animation), scroll the pending row in.
    useEffect(() => {
        if (!pendingScroll.current) return;
        let tries = 0;
        const tick = () => {
            if (!pendingScroll.current) return;
            if (highlight(pendingScroll.current) || ++tries > 20) pendingScroll.current = null;
            else window.setTimeout(tick, 50);
        };
        const id = window.setTimeout(tick, reduced ? 0 : 120);
        return () => window.clearTimeout(id);
    }, [tab, highlight, reduced]);

    const onRailKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        const i = SETTINGS_TABS.indexOf(tab);
        let next: number | null = null;
        if (e.key === "ArrowDown") next = (i + 1) % SETTINGS_TABS.length;
        else if (e.key === "ArrowUp") next = (i - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = SETTINGS_TABS.length - 1;
        if (next === null) return;
        e.preventDefault();
        const id = SETTINGS_TABS[next];
        if (!id) return;
        setTab(id);
        tabRefs.current[id]?.focus();
    };

    const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
        if (!searching) return;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setResultIdx((i) => Math.min(Math.min(results.length, 8) - 1, i + 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setResultIdx((i) => Math.max(0, i - 1));
        } else if (e.key === "Enter") {
            const r = results[resultIdx] ?? results[0];
            if (r) {
                e.preventDefault();
                jumpTo(r);
            }
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setQuery("");
        }
    };

    const doUndo = useCallback(async () => {
        const label = await undo();
        if (label) setStatus(t("settings.undone", { what: label }));
    }, [undo, setStatus, t]);

    // Ctrl+Z inside the modal (not in text fields) undoes the last change.
    const onModalKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z" && !isTextTarget(e.target)) {
            if (undoStack.length === 0) return;
            e.preventDefault();
            void doUndo();
        }
    };

    const sections = TAB_SECTIONS[tab];
    const doReset = async () => {
        if (!sections) return;
        const label = t("settings.undoReset", { tab: tabLabel(tab) });
        await runUndoable(label, () => apply(defaultSections(sections)));
        setStatus(t("settings.resetDone", { tab: tabLabel(tab) }));
    };

    const def = TAB_DEFS[tab];
    const Body = def.body;
    const lastUndo = undoStack[undoStack.length - 1];

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent
                size="xl"
                mobile="center"
                className="h-[min(760px,88vh)] w-[min(1100px,92vw)] max-w-none gap-0 overflow-hidden p-0 sm:max-w-none"
                onKeyDown={onModalKey}
            >
                <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] max-sm:grid-cols-[64px_minmax(0,1fr)]">
                    {/* Rail: never scrolls (10 tabs fit the min modal height). */}
                    <nav aria-label={t("settings.title")} className="flex min-h-0 flex-col gap-3 overflow-hidden border-r border-border bg-muted/30 p-3">
                        <DialogTitle className="px-2 pt-1 text-base max-sm:sr-only">{t("settings.title")}</DialogTitle>
                        <div className="relative max-sm:hidden">
                            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                            <Input
                                ref={searchRef}
                                size="sm"
                                type="search"
                                role="combobox"
                                aria-expanded={searching}
                                aria-controls="settings-search-results"
                                aria-activedescendant={searching && results[resultIdx] ? `settings-result-${results[resultIdx]?.id}` : undefined}
                                aria-label={t("settings.searchLabel")}
                                placeholder={t("settings.searchPlaceholder")}
                                value={query}
                                onChange={(e) => {
                                    setQuery(e.target.value);
                                    setResultIdx(0);
                                }}
                                onKeyDown={onSearchKey}
                                className="pl-8"
                            />
                        </div>
                        {searching ? (
                            <ul id="settings-search-results" role="listbox" aria-label={t("settings.searchResults")} className="grid content-start gap-0.5 overflow-hidden">
                                {results.length === 0 ? (
                                    <li className="px-2 py-1.5 text-xs text-muted-foreground" role="presentation">
                                        {t("common.noResults")}
                                    </li>
                                ) : (
                                    results.slice(0, 8).map((r, i) => (
                                        <li
                                            key={r.id}
                                            id={`settings-result-${r.id}`}
                                            role="option"
                                            aria-selected={i === resultIdx}
                                            onMouseDown={(e) => e.preventDefault()}
                                            onClick={() => jumpTo(r)}
                                            className={cn(
                                                "grid cursor-pointer gap-0.5 rounded-md px-2 py-1.5 text-sm",
                                                i === resultIdx ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-muted",
                                            )}
                                        >
                                            <span className="truncate font-medium text-foreground">{t(r.labelKey as MessageKey)}</span>
                                            <span className="truncate text-xs">{tabLabel(r.tab)}</span>
                                        </li>
                                    ))
                                )}
                            </ul>
                        ) : (
                            <LayoutGroup id="settings-rail">
                                <div role="tablist" aria-orientation="vertical" aria-label={t("settings.title")} className="grid content-start gap-0.5" onKeyDown={onRailKey}>
                                    {SETTINGS_TABS.map((id) => {
                                        const d = TAB_DEFS[id];
                                        const Icon = d.icon;
                                        const selected = id === tab;
                                        return (
                                            <button
                                                key={id}
                                                ref={(el) => {
                                                    tabRefs.current[id] = el;
                                                }}
                                                id={`settings-tab-${id}`}
                                                type="button"
                                                role="tab"
                                                aria-selected={selected}
                                                aria-controls="settings-tabpanel"
                                                tabIndex={selected ? 0 : -1}
                                                title={t(d.label)}
                                                onClick={() => setTab(id)}
                                                className={cn(
                                                    "relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm outline-none transition-colors duration-(--dur-fast) focus-visible:ring-3 focus-visible:ring-ring/40 max-sm:justify-center",
                                                    selected ? "text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                                                )}
                                            >
                                                {selected && (
                                                    <motion.span
                                                        layoutId={reduced ? undefined : "settings-tab-indicator"}
                                                        className="absolute inset-0 rounded-md bg-primary/12 ring-1 ring-primary/30"
                                                        transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34 }}
                                                        aria-hidden
                                                    />
                                                )}
                                                <Icon className="relative size-4 shrink-0" aria-hidden />
                                                <span className="relative truncate max-sm:sr-only">{t(d.label)}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </LayoutGroup>
                        )}
                    </nav>

                    <div className="flex min-h-0 min-w-0 flex-col">
                        <header className="flex items-start gap-3 border-b border-border px-6 py-4 pr-14">
                            <div className="grid min-w-0 flex-1 gap-1">
                                <h2 className="font-heading text-lg leading-tight font-semibold">{t(def.label)}</h2>
                                <DialogDescription className="text-sm">{t(def.desc)}</DialogDescription>
                            </div>
                            {sections && (
                                <Button variant="ghost" size="sm" onClick={() => setConfirmReset(true)}>
                                    <RotateCcw aria-hidden /> {t("settings.resetSection")}
                                </Button>
                            )}
                        </header>

                        <div ref={paneRef} id="settings-tabpanel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`} tabIndex={-1} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6 py-5 outline-none">
                            {/* Enter-only: the new tab mounts at once (an exit animation that never finishes,
                                e.g. in a hidden/occluded window, must not block the switch). */}
                            <motion.div
                                key={`${tab}-${rev}`}
                                initial={reduced ? false : { opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={reduced ? { duration: 0 } : { duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                            >
                                <Body />
                            </motion.div>
                        </div>

                        <footer className="flex flex-wrap items-center gap-2 border-t border-border px-6 py-3">
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={!lastUndo}
                                onClick={() => void doUndo()}
                                title={lastUndo ? t("settings.undoWhat", { what: lastUndo.label }) : undefined}
                            >
                                <Undo2 aria-hidden /> {t("settings.undo")}
                            </Button>
                            <p role="status" aria-live="polite" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                                {status ?? ""}
                            </p>
                            <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
                                <Download aria-hidden /> {t("settings.export")}
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => void startImport(() => setStatus(t("settings.importInvalid")))}>
                                <Upload aria-hidden /> {t("settings.import")}
                            </Button>
                            <DialogClose render={<Button size="sm" />}>{t("common.close")}</DialogClose>
                        </footer>
                    </div>
                </div>

                <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
                    <AlertDialogContent size="sm">
                        <AlertDialogHeader>
                            <AlertDialogTitle>{t("settings.resetTitle", { tab: t(def.label) })}</AlertDialogTitle>
                            <AlertDialogDescription>{t("settings.resetBody")}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                            <AlertDialogAction variant="destructive" onClick={() => void doReset()}>
                                {t("settings.resetSection")}
                            </AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
                <ExportDialog />
                <ImportDialog />
            </DialogContent>
        </Dialog>
    );
}
