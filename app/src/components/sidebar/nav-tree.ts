import {
    LayoutDashboard, Clapperboard, Library, Music2, Mic, Download,
    Monitor, Wrench, Settings, Disc3, Piano, Waves, Plug, CircleDot,
    ListMusic, Activity, UserCircle, HardDrive, ScanSearch, Smartphone,
    AudioWaveform, BookOpen, User, ShieldCheck, Palette, Bell,
    Home, Film, Tv, History, Sparkles, Bot, Brain,
    type LucideIcon,
} from "lucide-react";

export interface NavLeaf {
    kind: "leaf";
    key: string;
    href: string;
    label: string;
    icon: LucideIcon;
    /** When true, active match requires exact pathname equality. */
    exact?: boolean;
}

export interface NavParent {
    kind: "parent";
    key: string;
    label: string;
    icon: LucideIcon;
    /** Tailwind `from-X to-Y` gradient applied to the active accent. */
    accent: string;
    /** Auto-collapse the sidebar (focus mode) on these children's routes. */
    autoCollapse?: boolean;
    /** Show a 'Recent projects' section in the drilled view. */
    showProjects?: boolean;
    children: NavLeaf[];
}

export type NavNode = NavLeaf | NavParent;

export const navTree: NavNode[] = [
    {
        kind: "leaf", key: "dashboard", href: "/", label: "Dashboard",
        icon: LayoutDashboard, exact: true,
    },
    {
        kind: "parent", key: "watch", label: "Watch", icon: Clapperboard,
        accent: "from-rose-400 to-orange-500",
        children: [
            { kind: "leaf", key: "watch-browse", href: "/watch", label: "Home", icon: Home, exact: true },
            { kind: "leaf", key: "watch-movies", href: "/watch/movies", label: "Movies", icon: Film },
            { kind: "leaf", key: "watch-shows", href: "/watch/shows", label: "TV Shows", icon: Tv },
            { kind: "leaf", key: "watch-continue", href: "/watch/continue", label: "Continue", icon: History },
            { kind: "leaf", key: "watch-stats", href: "/watch/stats", label: "Stats", icon: Activity },
            { kind: "leaf", key: "watch-collections", href: "/watch/collections", label: "Collections", icon: Library },
            { kind: "leaf", key: "watch-profiles", href: "/profiles", label: "Profiles", icon: UserCircle },
            { kind: "leaf", key: "watch-settings", href: "/watch/settings", label: "Settings", icon: Settings },
        ],
    },
    {
        kind: "parent", key: "library", label: "Library", icon: Library,
        accent: "from-purple-400 to-fuchsia-500",
        children: [
            { kind: "leaf", key: "library-tracks", href: "/library", label: "Tracks", icon: Library, exact: true },
            { kind: "leaf", key: "playlists", href: "/playlists", label: "Playlists", icon: ListMusic },
            { kind: "leaf", key: "analysis", href: "/analysis", label: "Analysis", icon: Activity },
        ],
    },
    {
        kind: "parent", key: "music", label: "Music", icon: Music2,
        accent: "from-cyan-400 to-blue-500",
        showProjects: true,
        autoCollapse: true,
        children: [
            { kind: "leaf", key: "music-overview", href: "/music", label: "Overview", icon: LayoutDashboard, exact: true },
            { kind: "leaf", key: "mixer", href: "/mixer", label: "Mixer", icon: Disc3 },
            { kind: "leaf", key: "daw", href: "/daw", label: "DAW", icon: Piano },
            { kind: "leaf", key: "editor", href: "/editor", label: "Sound Editor", icon: Waves },
            { kind: "leaf", key: "plugins", href: "/plugins", label: "Plugins", icon: Plug },
            { kind: "leaf", key: "recordings", href: "/recordings", label: "Recordings", icon: CircleDot },
        ],
    },
    { kind: "leaf", key: "live", href: "/live", label: "Live", icon: Mic },
    { kind: "leaf", key: "download", href: "/download", label: "Download", icon: Download },
    {
        kind: "parent", key: "devices", label: "Devices", icon: Monitor,
        accent: "from-emerald-400 to-teal-500",
        children: [
            { kind: "leaf", key: "devices-list", href: "/devices", label: "Devices", icon: Monitor, exact: true },
            { kind: "leaf", key: "remote", href: "/remote", label: "Remote", icon: Smartphone },
            { kind: "leaf", key: "drives", href: "/drives", label: "Drives", icon: HardDrive },
            { kind: "leaf", key: "scanner", href: "/scanner", label: "Scanner", icon: ScanSearch },
        ],
    },
    {
        kind: "parent", key: "tools", label: "Tools", icon: Wrench,
        accent: "from-amber-400 to-yellow-500",
        children: [
            { kind: "leaf", key: "generate", href: "/generate", label: "AI Generate", icon: Sparkles },
            { kind: "leaf", key: "training", href: "/training", label: "Training", icon: Brain },
            { kind: "leaf", key: "visualizations", href: "/visualizations", label: "Visualizations", icon: AudioWaveform },
            { kind: "leaf", key: "learn", href: "/learn", label: "Learn", icon: BookOpen },
        ],
    },
    { kind: "leaf", key: "maestro", href: "/maestro", label: "Maestro", icon: Bot },
    {
        kind: "parent", key: "settings", label: "Settings", icon: Settings,
        accent: "from-slate-400 to-zinc-500",
        children: [
            { kind: "leaf", key: "settings-overview", href: "/settings", label: "Overview", icon: Settings, exact: true },
            { kind: "leaf", key: "settings-account", href: "/settings/account", label: "Account & billing", icon: User },
            { kind: "leaf", key: "settings-copilot", href: "/settings/copilot", label: "AI Copilot", icon: Sparkles },
            { kind: "leaf", key: "settings-profiles", href: "/settings/profiles", label: "Viewing profiles", icon: UserCircle },
            { kind: "leaf", key: "settings-security", href: "/settings/security", label: "Security", icon: ShieldCheck },
            { kind: "leaf", key: "settings-library", href: "/settings/library", label: "Library", icon: Library },
            { kind: "leaf", key: "settings-music", href: "/settings/music", label: "Music", icon: Music2 },
            { kind: "leaf", key: "settings-video", href: "/settings/video", label: "Video", icon: Clapperboard },
            { kind: "leaf", key: "settings-mixer", href: "/settings/mixer", label: "Mixer", icon: Disc3 },
            { kind: "leaf", key: "settings-daw", href: "/settings/daw", label: "DAW", icon: Piano },
            { kind: "leaf", key: "settings-editor", href: "/settings/sound-editor", label: "Sound Editor", icon: Waves },
            { kind: "leaf", key: "settings-live", href: "/settings/live", label: "Live", icon: Mic },
            { kind: "leaf", key: "settings-companions", href: "/settings/companions", label: "Companions", icon: Monitor },
            { kind: "leaf", key: "settings-devices", href: "/settings/devices", label: "Devices & remote", icon: Smartphone },
            { kind: "leaf", key: "settings-notifications", href: "/settings/notifications", label: "Notifications", icon: Bell },
            { kind: "leaf", key: "settings-appearance", href: "/settings/appearance", label: "Appearance & language", icon: Palette },
            { kind: "leaf", key: "settings-advanced", href: "/settings/advanced", label: "Advanced", icon: Settings },
        ],
    },
];

export function isLeafActive(leaf: NavLeaf, pathname: string): boolean {
    if (leaf.exact) return pathname === leaf.href;
    return pathname === leaf.href || pathname.startsWith(leaf.href + "/");
}

export function isLeafNode(n: NavNode): n is NavLeaf {
    return n.kind === "leaf";
}

/** Find the parent whose children cover the current pathname, if any. */
export function findActiveParent(pathname: string): NavParent | null {
    for (const n of navTree) {
        if (n.kind !== "parent") continue;
        if (n.children.some((c) => isLeafActive(c, pathname))) return n;
        // Also drill in when the user is on the parent's "namespace" but not
        // matched by a child (e.g. visiting /settings/foo/bar).
        const ns = "/" + n.key;
        if (pathname === ns || pathname.startsWith(ns + "/")) return n;
    }
    return null;
}

/** Flat list of all leaves for global lookups (search / pinning). */
export const allLeaves: NavLeaf[] = navTree.flatMap((n) =>
    n.kind === "leaf" ? [n] : n.children
);
