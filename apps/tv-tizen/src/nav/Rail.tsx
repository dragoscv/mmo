/**
 * Left navigation rail (`data-focus-zone="rail"`). Collapsed: icons only (~5.5rem). While any rail item has
 * focus it expands (transform/opacity only — the panel slides over the content, no relayout) and shows labels.
 * Items + order/visibility from prefs `navOrder`; profile avatar at the top; mini-player chip at the bottom
 * while music plays (opens Now Playing).
 */
import { useEffect, useState } from "react";
import { t, type MessageKey } from "../i18n/messages";
import type { Profile } from "../lib/media-types";
import { navOrder, PREFS_EVENT, type NavId } from "../lib/prefs";
import { useNowPlaying } from "../lib/player-bus";
import { Icon, type IconName } from "../ui/icons";
import { useNav } from "./Nav";
import type { Route } from "./routes";

interface RailItem { id: NavId; icon: IconName; label: MessageKey; route: Route }

const ITEMS: Record<NavId, RailItem> = {
    home: { id: "home", icon: "home", label: "nav.home", route: { name: "home" } },
    search: { id: "search", icon: "search", label: "nav.search", route: { name: "search" } },
    movies: { id: "movies", icon: "movie", label: "nav.movies", route: { name: "library", kind: "movie" } },
    shows: { id: "shows", icon: "tv", label: "nav.shows", route: { name: "library", kind: "tv" } },
    music: { id: "music", icon: "music", label: "nav.music", route: { name: "music" } },
    livetv: { id: "livetv", icon: "livetv", label: "nav.livetv", route: { name: "livetv" } },
    settings: { id: "settings", icon: "settings", label: "nav.settings", route: { name: "settings" } },
};

/** Which rail item a route belongs to (detail screens light up their section). */
export function railIdFor(r: Route): NavId | null {
    switch (r.name) {
        case "home": case "title": case "season": case "show": case "stats": case "together": return "home";
        case "search": return "search";
        case "library": return r.kind === "movie" ? "movies" : "shows";
        case "music": case "artist": case "album": case "nowPlaying": return "music";
        case "livetv": case "guide": case "recordings": case "livePlay": return "livetv";
        case "settings": return "settings";
        default: return null;
    }
}

function initials(name: string): string {
    const p = name.trim().split(/\s+/).filter(Boolean);
    return ((p[0]?.[0] ?? "?") + (p[1]?.[0] ?? "")).toUpperCase();
}

export function ProfileAvatar({ profile, size = "2.4rem" }: { profile: Profile | null; size?: string }) {
    const img = profile?.avatar && /^https?:\/\//i.test(profile.avatar) ? profile.avatar : null;
    return (
        <span className={`avatar${profile?.kind === "kid" ? " avatar-kid" : ""}`} style={{ width: size, height: size }} aria-hidden="true">
            {img ? <img src={img} alt="" decoding="async" /> : <span className="avatar-initials">{profile ? initials(profile.name) : <Icon name="user" />}</span>}
        </span>
    );
}

export interface RailProps {
    profile: Profile | null;
    onProfile: () => void;
}

export function Rail({ profile, onProfile }: RailProps) {
    const nav = useNav();
    const [order, setOrder] = useState<NavId[]>(() => navOrder());
    const [expanded, setExpanded] = useState(false);
    const np = useNowPlaying();
    const active = railIdFor(nav.current);

    useEffect(() => {
        const on = () => setOrder(navOrder());
        window.addEventListener(PREFS_EVENT, on);
        return () => window.removeEventListener(PREFS_EVENT, on);
    }, []);

    const go = (it: RailItem) => {
        if (active === it.id && nav.depth === 1) return;
        nav.resetTo(it.route);
    };

    return (
        <nav
            className={`rail${expanded ? " is-expanded" : ""}`}
            data-focus-zone="rail"
            aria-label={t("nav.label")}
            onFocus={() => setExpanded(true)}
            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setExpanded(false); }}
        >
            <div className="rail-panel" aria-hidden="true" />
            <button type="button" className="rail-item rail-profile" data-focusable="" data-focus-key="rail:profile"
                aria-label={profile ? `${t("nav.profile")}: ${profile.name}` : t("nav.profile")} onClick={onProfile}>
                <ProfileAvatar profile={profile} />
                <span className="rail-label">{profile?.name ?? t("nav.profile")}</span>
            </button>
            <div className="rail-items">
                {order.map((id) => {
                    const it = ITEMS[id];
                    const on = active === id;
                    return (
                        <button key={id} type="button" className={`rail-item${on ? " is-active" : ""}`} data-focusable=""
                            data-focus-key={`rail:${id}`} data-testid={`rail-${id}`} aria-current={on ? "page" : undefined}
                            aria-label={t(it.label)} onClick={() => go(it)}>
                            <Icon name={it.icon} className="rail-icon" />
                            <span className="rail-label">{t(it.label)}</span>
                        </button>
                    );
                })}
            </div>
            {np && np.kind === "audio" && (
                <button type="button" className="rail-item rail-mini" data-focusable="" data-focus-key="rail:mini"
                    aria-label={`${t("nav.nowPlaying")}: ${np.title}`} onClick={() => nav.push({ name: "nowPlaying" })}>
                    <span className="rail-mini-art">
                        {np.artUrl ? <img src={np.artUrl} alt="" decoding="async" /> : <Icon name="music" />}
                        <span className="rail-mini-state"><Icon name={np.playing ? "pause" : "play"} /></span>
                    </span>
                    <span className="rail-label rail-mini-text">
                        <span className="rail-mini-title">{np.title}</span>
                        {np.subtitle && <span className="rail-mini-sub">{np.subtitle}</span>}
                    </span>
                </button>
            )}
        </nav>
    );
}
