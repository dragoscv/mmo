"use client";

/**
 * WP9-02 — unified command palette on `@mmo/ui` `CommandDialog`.
 *
 * Groups: Navigate (every nav-tree leaf), Actions (focus mode, shortcuts
 * overlay, sign out, PWA install, …), Theme (mode / accent / surface /
 * density) and — once the query is ≥ 2 chars — the async library results
 * from the `globalSearch` server action (tracks, artists, albums, genres,
 * playlists, movies, shows, projects).
 *
 * Controlled (`open` / `onOpenChange`) so the sidebar search trigger and the
 * mobile header keep their existing contract. `mod+k` and `mod+shift+p`
 * toggle it through the shared shortcuts registry.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCommandState } from "cmdk";
import {
    CommandDialog,
    CommandGroup,
    CommandItem,
    CommandLoading,
    CommandSeparator,
    getShortcuts,
    useRegisterShortcut,
    useThemePrefs,
    type CommandItemDef,
} from "@mmo/ui";
import { ACCENTS, DENSITIES, MODES, SURFACES, type AccentPreset } from "@mmo/design-tokens";
import {
    BookOpen,
    Copy,
    Disc3,
    Download,
    Eye,
    EyeOff,
    Film,
    Hash,
    Keyboard,
    Laptop,
    Layers,
    LayoutGrid,
    ListMusic,
    LogOut,
    Moon,
    Palette,
    RefreshCw,
    Rows3,
    Search,
    Sparkles,
    Square,
    SquareDashed,
    Sun,
    Tv,
    User,
} from "lucide-react";
import { Artwork } from "@/components/artwork";
import { formatDuration, formatKey } from "@/lib/utils";
import { useDAWSettings } from "@/hooks/use-daw-settings";
import { globalSearch, type SearchResult } from "@/actions/search";
import { useFocusMode } from "@/components/focus-mode-context";
import { signOutAndPurge } from "@/lib/auth-client";
import { allLeaves } from "@/components/sidebar/nav-tree";

// ─── Pages ──────────────────────────────────────────────────────────────────

/** Extra pages not in the nav tree but worth surfacing in the palette. */
const EXTRA_PAGES = [{ key: "duplicates", href: "/library/duplicates", icon: Copy }] as const;

const PAGES = [...allLeaves.map((l) => ({ key: l.key, href: l.href, icon: l.icon })), ...EXTRA_PAGES];

const ACCENT_ORDER = Object.keys(ACCENTS) as AccentPreset[];

const MIN_QUERY = 2;
const ONBOARDING_KEY = "mmo.onboarding.dismissed";

// `beforeinstallprompt` isn't in lib.dom.d.ts yet (Web App Manifest WG draft).
interface BeforeInstallPromptEvent extends Event {
    readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
    prompt(): Promise<void>;
}

export interface CommandPaletteProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
    const router = useRouter();
    const t = useTranslations("palette");
    const tNav = useTranslations("nav");
    const { isFocusMode, toggleFocusMode } = useFocusMode();
    const { prefs, setPrefs } = useThemePrefs();

    // ⌘K / Ctrl+K and ⌘⇧P / Ctrl+Shift+P through the shared registry (listed in the overlay).
    const toggle = useCallback(() => onOpenChange(!open), [open, onOpenChange]);
    useRegisterShortcut(
        { id: "command-palette", keys: ["mod+k", "mod+shift+p"], label: t("title"), group: "general", global: true, handler: toggle },
        [toggle, t],
    );

    // PWA install prompt — same capture pattern as pwa-install-button.tsx (kept independent).
    const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);
    useEffect(() => {
        if (typeof window === "undefined") return;
        const onPrompt = (e: Event) => {
            e.preventDefault();
            setInstallEvt(e as BeforeInstallPromptEvent);
        };
        const onInstalled = () => setInstallEvt(null);
        window.addEventListener("beforeinstallprompt", onPrompt);
        window.addEventListener("appinstalled", onInstalled);
        return () => {
            window.removeEventListener("beforeinstallprompt", onPrompt);
            window.removeEventListener("appinstalled", onInstalled);
        };
    }, []);

    const navigate = useCallback(
        (href: string) => {
            onOpenChange(false);
            router.push(href);
        },
        [router, onOpenChange],
    );

    const items = useMemo<CommandItemDef[]>(() => {
        const navigateItems: CommandItemDef[] = PAGES.map((page) => {
            const Icon = page.icon;
            const kw = t.has(`pageKeywords.${page.key}`) ? t(`pageKeywords.${page.key}`) : "";
            return {
                id: `page-${page.key}`,
                group: "navigate",
                label: tNav.has(page.key) ? tNav(page.key) : page.key,
                icon: <Icon />,
                keywords: kw ? kw.split(/\s+/) : undefined,
                onSelect: () => router.push(page.href),
            };
        });

        const actionItems: CommandItemDef[] = [
            {
                id: "action-toggle-focus",
                group: "actions",
                label: isFocusMode ? t("exitFocus") : t("enterFocus"),
                icon: isFocusMode ? <EyeOff /> : <Eye />,
                keywords: ["focus", "chrome", "sidebar"],
                onSelect: toggleFocusMode,
            },
            {
                id: "action-shortcuts",
                group: "actions",
                label: t("shortcuts"),
                icon: <Keyboard />,
                keywords: ["keyboard", "shortcuts", "help", "taste"],
                shortcut: ["?"],
                // The overlay is mounted once in the root layout (shortcuts-overlay.tsx) and
                // owns its state; trigger it through the registry instead of a second mount.
                onSelect: () => {
                    const def = getShortcuts().find((s) => s.id === "shortcuts-overlay");
                    def?.handler(new KeyboardEvent("keydown", { key: "?" }));
                },
            },
            {
                id: "action-refresh",
                group: "actions",
                label: t("refresh"),
                icon: <RefreshCw />,
                keywords: ["reload", "refresh"],
                onSelect: () => router.refresh(),
            },
            {
                id: "action-usb-export",
                group: "actions",
                label: t("usbWizard"),
                icon: <Sparkles />,
                keywords: ["usb", "export", "rekordbox", "serato", "crate"],
                onSelect: () => router.push("/playlists?openUsbWizard=1"),
            },
            {
                id: "action-onboarding",
                group: "actions",
                label: t("onboarding"),
                icon: <BookOpen />,
                keywords: ["onboarding", "tour", "welcome", "wizard"],
                onSelect: () => {
                    try {
                        localStorage.removeItem(ONBOARDING_KEY);
                    } catch {
                        /* storage disabled */
                    }
                    router.push("/dashboard");
                },
            },
        ];
        if (installEvt) {
            actionItems.push({
                id: "action-install-pwa",
                group: "actions",
                label: t("installApp"),
                icon: <Download />,
                keywords: ["pwa", "install", "app", "instalează"],
                onSelect: () => {
                    void installEvt.prompt().then(() => setInstallEvt(null));
                },
            });
        }
        actionItems.push({
            id: "action-signout",
            group: "actions",
            label: t("signOut"),
            icon: <LogOut />,
            keywords: ["logout", "sign out", "deconectare"],
            onSelect: () => {
                void signOutAndPurge({ callbackUrl: "/" });
            },
        });

        const modeIcons = { light: <Sun />, dark: <Moon />, system: <Laptop /> } as const;
        const surfaceIcons = { glass: <SquareDashed />, solid: <Square />, flat: <LayoutGrid /> } as const;
        const nextAccent = ACCENT_ORDER[(Math.max(0, ACCENT_ORDER.indexOf(prefs.accent as AccentPreset)) + 1) % ACCENT_ORDER.length] ?? "violet";
        const themeItems: CommandItemDef[] = [
            ...MODES.map<CommandItemDef>((m) => ({
                id: `theme-mode-${m}`,
                group: "theme",
                label: t(`mode.${m}`),
                icon: modeIcons[m],
                keywords: ["theme", "mode", "temă", m],
                disabled: prefs.mode === m,
                onSelect: () => setPrefs({ mode: m }),
            })),
            {
                id: "theme-accent-cycle",
                group: "theme",
                label: t("cycleAccent", { accent: ACCENTS[nextAccent].label[prefs.locale] ?? nextAccent }),
                icon: <Palette />,
                keywords: ["accent", "colour", "color", "culoare", ...ACCENT_ORDER],
                onSelect: () => setPrefs({ accent: nextAccent }),
            },
            ...SURFACES.map<CommandItemDef>((s) => ({
                id: `theme-surface-${s}`,
                group: "theme",
                label: t(`surface.${s}`),
                icon: surfaceIcons[s],
                keywords: ["surface", "suprafață", s],
                disabled: prefs.surface === s,
                onSelect: () => setPrefs({ surface: s }),
            })),
            ...DENSITIES.map<CommandItemDef>((d) => ({
                id: `theme-density-${d}`,
                group: "theme",
                label: t(`density.${d}`),
                icon: <Rows3 />,
                keywords: ["density", "densitate", d],
                disabled: prefs.density === d,
                onSelect: () => setPrefs({ density: d }),
            })),
        ];

        return [...navigateItems, ...actionItems, ...themeItems];
    }, [t, tNav, router, isFocusMode, toggleFocusMode, installEvt, prefs.mode, prefs.surface, prefs.density, prefs.accent, prefs.locale, setPrefs]);

    return (
        <CommandDialog
            open={open}
            onOpenChange={onOpenChange}
            items={items}
            placeholder={t("placeholder")}
            groupLabels={{ navigate: t("navigate"), actions: t("actions"), theme: t("theme") }}
        >
            <LibraryResults active={open} navigate={navigate} />
        </CommandDialog>
    );
}

// ─── Library results (async, query ≥ 2) ────────────────────────────────────

function LibraryResults({ active, navigate }: { active: boolean; navigate: (href: string) => void }) {
    const t = useTranslations("palette");
    const { noteNotations } = useDAWSettings();
    const search = useCommandState((s) => s.search).trim();
    const [results, setResults] = useState<SearchResult | null>(null);
    const [isPending, startTransition] = useTransition();
    const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

    const hasQuery = search.length >= MIN_QUERY;

    // Reset on close (after the exit animation).
    useEffect(() => {
        if (active) return;
        const timer = setTimeout(() => setResults(null), 200);
        return () => clearTimeout(timer);
    }, [active]);

    // Debounced server-action search.
    useEffect(() => {
        if (!hasQuery) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when query cleared
            setResults(null);
            return;
        }
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            startTransition(async () => {
                const data = await globalSearch(search);
                // eslint-disable-next-line react-hooks/set-state-in-effect -- async data fetch result; cannot derive
                setResults(data);
            });
        }, 200);
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, [search, hasQuery]);

    if (!hasQuery) return null;

    // Every result already matched server-side: pass the query as a keyword so
    // cmdk's client filter never hides it (e.g. an artist match on a track).
    const kw = [search];
    const trackCount = (n: number) => t("trackCount", { count: n });

    return (
        <>
            <CommandSeparator />
            <CommandGroup heading={t("library")}>
                <CommandItem value="library-search" keywords={kw} onSelect={() => navigate(`/library?search=${encodeURIComponent(search)}&page=1`)}>
                    <Search />
                    <span className="truncate">{t("searchLibrary", { query: search })}</span>
                </CommandItem>
                {isPending && !results ? <CommandLoading>{t("searching")}</CommandLoading> : null}
            </CommandGroup>

            {results && results.tracks.length > 0 && (
                <CommandGroup heading={t("tracks")}>
                    {results.tracks.map((track) => (
                        <CommandItem
                            key={`track-${track.id}`}
                            value={`track-${track.id}`}
                            keywords={kw}
                            className="h-auto py-2"
                            onSelect={() => navigate(`/library?search=${encodeURIComponent(track.title || "")}&page=1`)}
                        >
                            <Artwork src={track.artworkUrl} alt={track.title || "Track"} size="sm" className="rounded-md" />
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">{track.title || "—"}</p>
                                <p className="truncate text-xs text-muted-foreground">
                                    {track.artist || "—"}
                                    {track.album && ` · ${track.album}`}
                                </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-2 text-[10px] tabular-nums text-muted-foreground">
                                {track.bpm ? <span>{Math.round(track.bpm)} BPM</span> : null}
                                {track.keyCamelot ? <span>{formatKey(track.keyCamelot, noteNotations)}</span> : null}
                                {track.duration ? <span className="w-8 text-right">{formatDuration(track.duration)}</span> : null}
                            </div>
                        </CommandItem>
                    ))}
                </CommandGroup>
            )}

            {results && results.artists.length > 0 && (
                <CommandGroup heading={t("artists")}>
                    {results.artists.map((artist) => (
                        <CommandItem key={`artist-${artist.name}`} value={`artist-${artist.name}`} keywords={kw} onSelect={() => navigate(`/library?artist=${encodeURIComponent(artist.name)}&page=1`)}>
                            <User />
                            <span className="min-w-0 flex-1 truncate">{artist.name}</span>
                            <span className="text-[11px] text-muted-foreground">{trackCount(artist.trackCount)}</span>
                        </CommandItem>
                    ))}
                </CommandGroup>
            )}

            {results && results.albums.length > 0 && (
                <CommandGroup heading={t("albums")}>
                    {results.albums.map((album) => (
                        <CommandItem key={`album-${album.name}`} value={`album-${album.name}`} keywords={kw} onSelect={() => navigate(`/library?album=${encodeURIComponent(album.name)}&page=1`)}>
                            <Disc3 />
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">{album.name}</p>
                                {album.artist ? <p className="truncate text-xs text-muted-foreground">{album.artist}</p> : null}
                            </div>
                            <span className="text-[11px] text-muted-foreground">{trackCount(album.trackCount)}</span>
                        </CommandItem>
                    ))}
                </CommandGroup>
            )}

            {results && results.genres.length > 0 && (
                <CommandGroup heading={t("genres")}>
                    {results.genres.map((genre) => (
                        <CommandItem key={`genre-${genre.name}`} value={`genre-${genre.name}`} keywords={kw} onSelect={() => navigate(`/library?genre=${encodeURIComponent(genre.name)}&page=1`)}>
                            <Hash />
                            <span className="min-w-0 flex-1 truncate">{genre.name}</span>
                            <span className="text-[11px] text-muted-foreground">{trackCount(genre.trackCount)}</span>
                        </CommandItem>
                    ))}
                </CommandGroup>
            )}

            {results && results.playlists.length > 0 && (
                <CommandGroup heading={t("playlists")}>
                    {results.playlists.map((pl) => (
                        <CommandItem key={`playlist-${pl.id}`} value={`playlist-${pl.id}`} keywords={kw} onSelect={() => navigate(`/playlists?id=${pl.id}`)}>
                            <ListMusic />
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">{pl.name}</p>
                                {pl.description ? <p className="truncate text-xs text-muted-foreground">{pl.description}</p> : null}
                            </div>
                            <span className="text-[11px] text-muted-foreground">{trackCount(pl.trackCount)}</span>
                        </CommandItem>
                    ))}
                </CommandGroup>
            )}

            {results && results.movies.length > 0 && (
                <CommandGroup heading={t("movies")}>
                    {results.movies.map((m) => (
                        <CommandItem key={`movie-${m.id}`} value={`movie-${m.id}`} keywords={kw} className="h-auto py-2" onSelect={() => navigate(`/watch/movies/${m.id}`)}>
                            <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                                {m.posterPath ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={`https://image.tmdb.org/t/p/w92${m.posterPath}`} alt="" className="h-full w-full object-cover" />
                                ) : (
                                    <Film />
                                )}
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">{m.title}</p>
                                {m.year ? <p className="text-xs text-muted-foreground">{m.year}</p> : null}
                            </div>
                            {m.rating != null && m.rating > 0 ? <span className="text-[11px] text-warning">★ {m.rating.toFixed(1)}</span> : null}
                        </CommandItem>
                    ))}
                </CommandGroup>
            )}

            {results && results.shows.length > 0 && (
                <CommandGroup heading={t("shows")}>
                    {results.shows.map((s) => (
                        <CommandItem key={`show-${s.id}`} value={`show-${s.id}`} keywords={kw} className="h-auto py-2" onSelect={() => navigate(`/watch/shows/${s.id}`)}>
                            <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                                {s.posterPath ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={`https://image.tmdb.org/t/p/w92${s.posterPath}`} alt="" className="h-full w-full object-cover" />
                                ) : (
                                    <Tv />
                                )}
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">{s.title}</p>
                                {s.firstAirYear ? <p className="text-xs text-muted-foreground">{s.firstAirYear}</p> : null}
                            </div>
                            {s.rating != null && s.rating > 0 ? <span className="text-[11px] text-warning">★ {s.rating.toFixed(1)}</span> : null}
                        </CommandItem>
                    ))}
                </CommandGroup>
            )}

            {results && results.projects.length > 0 && (
                <CommandGroup heading={t("projects")}>
                    {results.projects.map((p) => (
                        <CommandItem key={`proj-${p.kind}-${p.id}`} value={`proj-${p.kind}-${p.id}`} keywords={kw} onSelect={() => navigate(p.href)}>
                            <Layers />
                            <span className="min-w-0 flex-1 truncate">{p.name}</span>
                            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{p.kind}</span>
                        </CommandItem>
                    ))}
                </CommandGroup>
            )}
        </>
    );
}
