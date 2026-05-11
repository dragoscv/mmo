"use client";

import { useState, useEffect, useCallback, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Command,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { Command as CommandPrimitive } from "cmdk";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useRenderCount, dlog } from "@/lib/dev-debugger";
import { Artwork } from "@/components/artwork";
import {
  Search,
  Music,
  User,
  Disc3,
  ListMusic,
  LayoutDashboard,
  Library,
  ScanSearch,
  HardDrive,
  Settings,
  AudioWaveform,
  Hash,
  ArrowRight,
  Loader2,
  Eye,
  EyeOff,
  RefreshCw,
  LogOut,
  Sparkles,
  Copy,
  BookOpen,
} from "lucide-react";
import { cn, formatDuration, formatKey } from "@/lib/utils";
import { useDAWSettings } from "@/hooks/use-daw-settings";
import { globalSearch, type SearchResult } from "@/actions/search";
import { usePlayer } from "@/components/player-context";
import { useFocusMode } from "@/components/focus-mode-context";
import { signOutAndPurge } from "@/lib/auth-client";

const PAGES = [
  { label: "Dashboard", key: "dashboard", href: "/", icon: LayoutDashboard, keywords: "home overview stats" },
  { label: "Library", key: "library", href: "/library", icon: Library, keywords: "tracks songs music browse" },
  { label: "Duplicates", key: "duplicates", href: "/library/duplicates", icon: Copy, keywords: "duplicate dedupe sha fingerprint exact fuzzy audio" },
  { label: "Playlists", key: "playlists", href: "/playlists", icon: ListMusic, keywords: "playlist collections sets" },
  { label: "Visualizations", key: "visualizations", href: "/visualizations", icon: AudioWaveform, keywords: "charts graphs visual" },
  { label: "Scanner", key: "scanner", href: "/scanner", icon: ScanSearch, keywords: "scan import analyze folder" },
  { label: "Drives", key: "drives", href: "/drives", icon: HardDrive, keywords: "usb disk drive export" },
  { label: "Settings", key: "settings", href: "/settings", icon: Settings, keywords: "preferences config options" },
] as const;

interface GlobalSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function GlobalSearch({ open, onOpenChange }: GlobalSearchProps) {
  useRenderCount("GlobalSearch");
  const router = useRouter();
  const player = usePlayer();
  const { noteNotations } = useDAWSettings();
  const { isFocusMode, toggleFocusMode } = useFocusMode();
  const t = useTranslations("palette");
  const tNav = useTranslations("nav");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult | null>(null);
  const [isPending, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset on close
  useEffect(() => {
    if (!open) {
      // Small delay so animations finish
      const t = setTimeout(() => {
        setQuery("");
        setResults(null);
      }, 200);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when query cleared
      setResults(null);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      startTransition(async () => {
        const data = await globalSearch(query);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- async data fetch result; cannot derive
        setResults(data);
      });
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Keyboard shortcut
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onOpenChange]);

  const navigate = useCallback(
    (href: string) => {
      onOpenChange(false);
      router.push(href);
    },
    [router, onOpenChange]
  );

  const playTrack = useCallback(
    (trackId: number) => {
      // Navigate to library with the track focused
      onOpenChange(false);
      router.push(`/library?search=&page=1`);
      // We can't directly play from search, so navigate to library
      // The user can then play from there
    },
    [router, onOpenChange]
  );

  const hasQuery = query.trim().length > 0;
  const hasResults =
    results &&
    (results.tracks.length > 0 ||
      results.artists.length > 0 ||
      results.albums.length > 0 ||
      results.genres.length > 0 ||
      results.playlists.length > 0);
  const totalResults = results
    ? results.tracks.length +
      results.artists.length +
      results.albums.length +
      results.genres.length +
      results.playlists.length
    : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTitle className="sr-only">Global Search</DialogTitle>
      <DialogContent
        className="top-[20%] translate-y-0 overflow-hidden rounded-2xl! p-0 gap-0 max-w-[640px] border-border/50 shadow-2xl"
        showCloseButton={false}
      >
        <Command
          className="rounded-none! bg-transparent! p-0!"
          shouldFilter={!hasQuery}
        >
          {/* Search input */}
          <div className="flex items-center border-b border-border/50 px-4">
            <Search className="mr-3 h-4 w-4 shrink-0 text-muted-foreground/60" />
            <CommandPrimitive.Input
              ref={inputRef}
              placeholder={t("placeholder")}
              value={query}
              onValueChange={setQuery}
              className="flex h-12 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-50"
            />
            {isPending && (
              <Loader2 className="ml-2 h-4 w-4 shrink-0 animate-spin text-muted-foreground/60" />
            )}
            <kbd className="ml-3 inline-flex h-5 items-center rounded border border-border/60 bg-muted/50 px-1.5 font-mono text-[10px] font-medium text-muted-foreground/60">
              ESC
            </kbd>
          </div>

          <CommandList className="max-h-[400px] overflow-y-auto p-2">
            {/* No query → show pages & quick actions */}
            {!hasQuery && (
              <>
                <CommandGroup heading={t("actions")}>
                  <CommandItem
                    value="action-toggle-focus toggle focus mode hide chrome"
                    onSelect={() => {
                      onOpenChange(false);
                      toggleFocusMode();
                    }}
                    className="gap-3 rounded-lg px-3 py-2.5"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/80">
                      {isFocusMode
                        ? <EyeOff className="h-4 w-4 text-muted-foreground" />
                        : <Eye className="h-4 w-4 text-muted-foreground" />}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium">
                        {isFocusMode ? t("exitFocus") : t("enterFocus")}
                      </p>
                    </div>
                    <CommandShortcut>F</CommandShortcut>
                  </CommandItem>
                  <CommandItem
                    value="action-refresh refresh reload page"
                    onSelect={() => {
                      onOpenChange(false);
                      router.refresh();
                    }}
                    className="gap-3 rounded-lg px-3 py-2.5"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/80">
                      <RefreshCw className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium">{t("refresh")}</p>
                    </div>
                  </CommandItem>
                  <CommandItem
                    value="action-usb-export usb export wizard rekordbox serato crate"
                    onSelect={() => navigate("/playlists?openUsbWizard=1")}
                    className="gap-3 rounded-lg px-3 py-2.5"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/80">
                      <Sparkles className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium">{t("usbWizard")}</p>
                      <p className="text-[11px] text-muted-foreground/60">{t("usbWizardHint")}</p>
                    </div>
                  </CommandItem>
                  <CommandItem
                    value="action-onboarding show onboarding wizard tour welcome"
                    onSelect={() => {
                      try { localStorage.removeItem("mmo.onboarding.dismissed"); } catch { /* noop */ }
                      navigate("/");
                    }}
                    className="gap-3 rounded-lg px-3 py-2.5"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/80">
                      <BookOpen className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium">{t("onboarding")}</p>
                      <p className="text-[11px] text-muted-foreground/60">{t("onboardingHint")}</p>
                    </div>
                  </CommandItem>
                  <CommandItem
                    value="action-signout sign out logout"
                    onSelect={() => {
                      onOpenChange(false);
                      signOutAndPurge({ callbackUrl: "/" });
                    }}
                    className="gap-3 rounded-lg px-3 py-2.5"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/80">
                      <LogOut className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium">{t("signOut")}</p>
                    </div>
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator className="my-1" />
                <CommandGroup heading={t("pages")}>
                  {PAGES.map((page) => (
                    <CommandItem
                      key={page.href}
                      value={`page-${page.label} ${page.keywords}`}
                      onSelect={() => navigate(page.href)}
                      className="gap-3 rounded-lg px-3 py-2.5"
                    >
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/80">
                        <page.icon className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium">{tNav(page.key)}</p>
                      </div>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/40" />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {/* Loading state */}
            {hasQuery && isPending && !results && (
              <div className="flex items-center justify-center py-12">
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/40" />
                  <p className="text-xs text-muted-foreground/50">{t("searching")}</p>
                </div>
              </div>
            )}

            {/* No results */}
            {hasQuery && !isPending && results && !hasResults && (
              <div className="flex flex-col items-center justify-center py-12 gap-2">
                <Search className="h-8 w-8 text-muted-foreground/20" />
                <p className="text-sm text-muted-foreground/50">
                  {t("noResults", { query })}
                </p>
                <p className="text-xs text-muted-foreground/30">
                  {t("tryDifferent")}
                </p>
              </div>
            )}

            {/* ─── Results ─────────────────────────────── */}
            {hasQuery && hasResults && results && (
              <>
                {/* Summary */}
                <div className="px-3 py-1.5">
                  <p className="text-[11px] font-medium text-muted-foreground/50">
                    {t("resultsCount", { count: totalResults, query })}
                  </p>
                </div>

                {/* Tracks */}
                {results.tracks.length > 0 && (
                  <CommandGroup heading={t("tracks")}>
                    {results.tracks.map((track) => (
                      <CommandItem
                        key={`track-${track.id}`}
                        value={`track-${track.id}-${track.title}-${track.artist}`}
                        onSelect={() =>
                          navigate(
                            `/library?search=${encodeURIComponent(track.title || "")}&page=1`
                          )
                        }
                        className="gap-3 rounded-lg px-3 py-2"
                      >
                        <Artwork
                          src={track.artworkUrl}
                          alt={track.title || "Track"}
                          size="sm"
                          className="rounded-md"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">
                            {track.title || "Unknown Title"}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {track.artist || "Unknown Artist"}
                            {track.album && ` · ${track.album}`}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {track.bpm && (
                            <span className="text-[10px] text-muted-foreground/50 tabular-nums">
                              {Math.round(track.bpm)} BPM
                            </span>
                          )}
                          {track.keyCamelot && (
                            <span className="text-[10px] text-muted-foreground/50">
                              {formatKey(track.keyCamelot, noteNotations)}
                            </span>
                          )}
                          {track.duration && (
                            <span className="text-[10px] text-muted-foreground/50 tabular-nums w-8 text-right">
                              {formatDuration(track.duration)}
                            </span>
                          )}
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}

                {/* Artists */}
                {results.artists.length > 0 && (
                  <>
                    <CommandSeparator className="my-1" />
                    <CommandGroup heading={t("artists")}>
                      {results.artists.map((artist) => (
                        <CommandItem
                          key={`artist-${artist.name}`}
                          value={`artist-${artist.name}`}
                          onSelect={() =>
                            navigate(
                              `/library?artist=${encodeURIComponent(artist.name)}&page=1`
                            )
                          }
                          className="gap-3 rounded-lg px-3 py-2"
                        >
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-purple-500/10 to-fuchsia-500/10">
                            <User className="h-3.5 w-3.5 text-purple-400" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{artist.name}</p>
                          </div>
                          <span className="text-[11px] text-muted-foreground/50">
                            {artist.trackCount} track{artist.trackCount !== 1 ? "s" : ""}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                )}

                {/* Albums */}
                {results.albums.length > 0 && (
                  <>
                    <CommandSeparator className="my-1" />
                    <CommandGroup heading={t("albums")}>
                      {results.albums.map((album) => (
                        <CommandItem
                          key={`album-${album.name}`}
                          value={`album-${album.name}-${album.artist}`}
                          onSelect={() =>
                            navigate(
                              `/library?album=${encodeURIComponent(album.name)}&page=1`
                            )
                          }
                          className="gap-3 rounded-lg px-3 py-2"
                        >
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500/10 to-cyan-500/10">
                            <Disc3 className="h-3.5 w-3.5 text-blue-400" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{album.name}</p>
                            {album.artist && (
                              <p className="text-xs text-muted-foreground truncate">
                                {album.artist}
                              </p>
                            )}
                          </div>
                          <span className="text-[11px] text-muted-foreground/50">
                            {album.trackCount} track{album.trackCount !== 1 ? "s" : ""}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                )}

                {/* Genres */}
                {results.genres.length > 0 && (
                  <>
                    <CommandSeparator className="my-1" />
                    <CommandGroup heading={t("genres")}>
                      {results.genres.map((genre) => (
                        <CommandItem
                          key={`genre-${genre.name}`}
                          value={`genre-${genre.name}`}
                          onSelect={() =>
                            navigate(
                              `/library?genre=${encodeURIComponent(genre.name)}&page=1`
                            )
                          }
                          className="gap-3 rounded-lg px-3 py-2"
                        >
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500/10 to-teal-500/10">
                            <Hash className="h-3.5 w-3.5 text-emerald-400" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{genre.name}</p>
                          </div>
                          <span className="text-[11px] text-muted-foreground/50">
                            {genre.trackCount} track{genre.trackCount !== 1 ? "s" : ""}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                )}

                {/* Playlists */}
                {results.playlists.length > 0 && (
                  <>
                    <CommandSeparator className="my-1" />
                    <CommandGroup heading={t("playlists")}>
                      {results.playlists.map((pl) => (
                        <CommandItem
                          key={`playlist-${pl.id}`}
                          value={`playlist-${pl.id}-${pl.name}`}
                          onSelect={() => navigate(`/playlists?id=${pl.id}`)}
                          className="gap-3 rounded-lg px-3 py-2"
                        >
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500/10 to-amber-500/10">
                            <ListMusic className="h-3.5 w-3.5 text-orange-400" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{pl.name}</p>
                            {pl.description && (
                              <p className="text-xs text-muted-foreground truncate">
                                {pl.description}
                              </p>
                            )}
                          </div>
                          <span className="text-[11px] text-muted-foreground/50">
                            {pl.trackCount} track{pl.trackCount !== 1 ? "s" : ""}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                )}
              </>
            )}
          </CommandList>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-border/50 px-4 py-2">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1">
                <kbd className="inline-flex h-5 items-center rounded border border-border/60 bg-muted/50 px-1 font-mono text-[10px] font-medium text-muted-foreground/50">
                  ↑↓
                </kbd>
                <span className="text-[10px] text-muted-foreground/40">navigate</span>
              </div>
              <div className="flex items-center gap-1">
                <kbd className="inline-flex h-5 items-center rounded border border-border/60 bg-muted/50 px-1 font-mono text-[10px] font-medium text-muted-foreground/50">
                  ↵
                </kbd>
                <span className="text-[10px] text-muted-foreground/40">select</span>
              </div>
              <div className="flex items-center gap-1">
                <kbd className="inline-flex h-5 items-center rounded border border-border/60 bg-muted/50 px-1 font-mono text-[10px] font-medium text-muted-foreground/50">
                  esc
                </kbd>
                <span className="text-[10px] text-muted-foreground/40">close</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Music className="h-3 w-3 text-purple-400/50" />
              <span className="text-[10px] text-muted-foreground/30">
                Global Search
              </span>
            </div>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
