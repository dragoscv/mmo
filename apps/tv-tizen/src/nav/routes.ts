/**
 * Route union for the TV app. Every route is a plain object `{ name, ...params }`; screens receive the
 * narrowed object as `params` (see `ScreenProps<N>` in ./ctx.ts).
 */
import type { ProbedVideo } from "../lib/api";
import type { DiscoveredServer } from "../lib/discovery";
import type { AlbumCard, MediaKind, TitleCard } from "../lib/media-types";
import type { TitleRef } from "../lib/progress-sync";
import type { Show } from "../lib/shows";
import type { SubsonicAlbum, SubsonicSong } from "../lib/api";

/** What the Player plays (WP15 behaviour: direct / HLS `q=original`+caps / `?start=` resume). */
export type PlayItem =
    | { kind: "video"; video: ProbedVideo; ref?: TitleRef; resumeSec?: number }
    | { kind: "audio"; song: SubsonicSong; album: SubsonicAlbum };

export type Route =
    // ── onboarding (no rail) ──
    | { name: "welcome" }
    | { name: "signin" }
    | { name: "discover"; preselected: DiscoveredServer | null }
    | { name: "pair"; server: DiscoveredServer }
    | { name: "connect" }
    | { name: "profiles"; manage?: boolean }
    // ── top-level (rail; Back → rail → exit dialog) ──
    | { name: "home" }
    | { name: "search"; initial?: string }
    | { name: "library"; kind: MediaKind }
    | { name: "music" }
    | { name: "livetv" }
    | { name: "settings"; section?: string }
    // ── detail (rail visible, Back pops) ──
    | { name: "title"; kind: MediaKind; tmdbId: number; seed?: TitleCard }
    | { name: "season"; tmdbId: number; season: number; showTitle?: string }
    | { name: "show"; show: Show }
    | { name: "artist"; id: string }
    /** `id` = Subsonic album id (same id `/media/music/albums/{id}` takes). */
    | { name: "album"; id: string; seed?: AlbumCard }
    | { name: "guide" }
    | { name: "recordings" }
    | { name: "stats"; year?: number }
    | { name: "together"; roomId?: string }
    // ── full screen (no rail) ──
    | { name: "nowPlaying" }
    | { name: "livePlay"; channelId: string }
    | { name: "player"; item: PlayItem; queue?: PlayItem[]; index?: number };

export type RouteName = Route["name"];
export type RouteOf<N extends RouteName> = Extract<Route, { name: N }>;

/** Back on these focuses the rail first, then asks to exit. */
export const TOP_LEVEL: ReadonlySet<RouteName> = new Set<RouteName>(["home", "search", "library", "music", "livetv", "settings"]);

/** Routes rendered without the rail (full-bleed). */
export const NO_RAIL: ReadonlySet<RouteName> = new Set<RouteName>([
    "welcome", "signin", "discover", "pair", "connect", "profiles", "player", "livePlay", "nowPlaying",
]);

export function hasRail(r: Route): boolean { return !NO_RAIL.has(r.name); }

/** Identity used by `resetTo` to reuse a live root entry (same screen + same params). */
export function routeKey(r: Route): string {
    switch (r.name) {
        case "library": return `library:${r.kind}`;
        case "title": return `title:${r.kind}:${r.tmdbId}`;
        case "season": return `season:${r.tmdbId}:${r.season}`;
        case "artist": return `artist:${r.id}`;
        case "album": return `album:${r.id}`;
        case "livePlay": return `livePlay:${r.channelId}`;
        case "search": return `search:${r.initial ?? ""}`;
        case "settings": return `settings:${r.section ?? ""}`;
        default: return r.name;
    }
}
