"use client";

import { useEffect, useState, useRef, type ReactNode } from "react";
import Link from "next/link";
import { useRenderCount } from "@/lib/dev-debugger";
import {
    Music,
    CheckCircle,
    Activity,
    Clock,
    Heart,
    ListMusic,
    Sparkles,
    ArrowRight,
    Star,
    Disc3,
    BarChart3,
    Zap,
    Shield,
    ImageOff,
    KeyRound,
    ChevronRight,
    TrendingUp,
    HardDrive,
} from "lucide-react";
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    Tooltip,
    ResponsiveContainer,
    Cell,
    CartesianGrid,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Artwork } from "@/components/artwork";
import { DashboardActions } from "@/components/dashboard-actions";
import { cn, formatBytes, formatKey } from "@/lib/utils";
import { useDAWSettings } from "@/hooks/use-daw-settings";
import type { DashboardStats } from "@/actions/tracks";
import type { RecommendedCategory } from "@/actions/playlists";

// ── Types ────────────────────────────────────────────────────────

interface ScanLog {
    id: number;
    action: string;
    filepath: string;
    details: string | null;
    scannedAt: string | null;
}

interface DashboardClientProps {
    stats: DashboardStats;
    recommendedCategories: RecommendedCategory[];
    recentScans: ScanLog[];
}

// ── Constants ────────────────────────────────────────────────────

const CHART_COLORS = [
    "#8b5cf6", "#22c55e", "#3b82f6", "#ef4444", "#eab308",
    "#f97316", "#06b6d4", "#ec4899", "#14b8a6", "#a855f7",
    "#6366f1", "#10b981", "#f43f5e", "#84cc16",
];

const ENERGY_HEX: Record<number, string> = {
    1: "#3b82f6", 2: "#06b6d4", 3: "#22c55e", 4: "#84cc16", 5: "#eab308",
    6: "#f97316", 7: "#ef4444", 8: "#dc2626", 9: "#db2777", 10: "#e11d48",
};

const BPM_GRADIENT = ["#8b5cf6", "#6366f1", "#3b82f6", "#06b6d4", "#22c55e", "#eab308", "#ef4444"];

const STAT_THEMES = {
    purple: {
        border: "border-purple-500/20 hover:border-purple-500/40",
        bg: "bg-purple-500/10 text-purple-400",
        gradient: "from-purple-500/[0.04] to-transparent",
        glow: "group-hover:shadow-purple-500/10",
    },
    green: {
        border: "border-green-500/20 hover:border-green-500/40",
        bg: "bg-green-500/10 text-green-400",
        gradient: "from-green-500/[0.04] to-transparent",
        glow: "group-hover:shadow-green-500/10",
    },
    blue: {
        border: "border-blue-500/20 hover:border-blue-500/40",
        bg: "bg-blue-500/10 text-blue-400",
        gradient: "from-blue-500/[0.04] to-transparent",
        glow: "group-hover:shadow-blue-500/10",
    },
    cyan: {
        border: "border-cyan-500/20 hover:border-cyan-500/40",
        bg: "bg-cyan-500/10 text-cyan-400",
        gradient: "from-cyan-500/[0.04] to-transparent",
        glow: "group-hover:shadow-cyan-500/10",
    },
    rose: {
        border: "border-rose-500/20 hover:border-rose-500/40",
        bg: "bg-rose-500/10 text-rose-400",
        gradient: "from-rose-500/[0.04] to-transparent",
        glow: "group-hover:shadow-rose-500/10",
    },
    amber: {
        border: "border-amber-500/20 hover:border-amber-500/40",
        bg: "bg-amber-500/10 text-amber-400",
        gradient: "from-amber-500/[0.04] to-transparent",
        glow: "group-hover:shadow-amber-500/10",
    },
} as const;

const TOOLTIP_STYLE = {
    contentStyle: {
        background: "var(--card)",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        color: "var(--foreground)",
        fontSize: "12px",
    },
};

// ── Hooks ────────────────────────────────────────────────────────

function useCountUp(target: number, duration = 1200, delay = 0) {
    const [value, setValue] = useState(0);

    useEffect(() => {
        if (target === 0) { setValue(0); return; }
        const timeout = setTimeout(() => {
            let startTime: number;
            let rafId: number;
            function animate(ts: number) {
                if (!startTime) startTime = ts;
                const progress = Math.min((ts - startTime) / duration, 1);
                const eased = 1 - Math.pow(1 - progress, 4);
                setValue(Math.round(target * eased));
                if (progress < 1) rafId = requestAnimationFrame(animate);
            }
            rafId = requestAnimationFrame(animate);
            return () => cancelAnimationFrame(rafId);
        }, delay);
        return () => clearTimeout(timeout);
    }, [target, duration, delay]);

    return value;
}

function useInView(threshold = 0.1) {
    const ref = useRef<HTMLDivElement>(null);
    const [inView, setInView] = useState(false);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const observer = new IntersectionObserver(
            ([entry]) => { if (entry.isIntersecting) setInView(true); },
            { threshold }
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [threshold]);

    return { ref, inView };
}

// ── Sub-components ───────────────────────────────────────────────

function AnimatedSection({
    delay = 0,
    children,
    className,
}: {
    delay?: number;
    children: ReactNode;
    className?: string;
}) {
    const { ref, inView } = useInView(0.05);
    return (
        <div
            ref={ref}
            className={cn(
                "transition-all duration-700 ease-out",
                inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6",
                className
            )}
            style={{ transitionDelay: inView ? `${delay}ms` : "0ms" }}
        >
            {children}
        </div>
    );
}

function StatCard({
    title,
    value,
    formattedValue,
    icon,
    description,
    theme,
    delay,
    skipCountUp,
}: {
    title: string;
    value: number;
    formattedValue?: string;
    icon: ReactNode;
    description?: string;
    theme: keyof typeof STAT_THEMES;
    delay: number;
    skipCountUp?: boolean;
}) {
    const animated = useCountUp(skipCountUp ? 0 : value, 1400, delay + 200);
    const colors = STAT_THEMES[theme];
    const displayValue = skipCountUp
        ? (formattedValue || value.toLocaleString())
        : (formattedValue
            ? formattedValue.replace(/[\d,]+/, String(animated.toLocaleString()))
            : animated.toLocaleString());

    return (
        <div
            className={cn(
                "group relative overflow-hidden rounded-xl border bg-card p-5 transition-all duration-300",
                "hover:shadow-lg",
                colors.border,
                colors.glow
            )}
        >
            <div className={cn("absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none", colors.gradient)} />
            <div className="relative">
                <div className={cn("flex h-10 w-10 items-center justify-center rounded-xl transition-colors duration-300", colors.bg)}>
                    {icon}
                </div>
                <div className="mt-3">
                    <p className="text-2xl font-bold tabular-nums tracking-tight">
                        {displayValue}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">{title}</p>
                    {description && (
                        <p className="text-xs text-muted-foreground/70 mt-0.5">{description}</p>
                    )}
                </div>
            </div>
        </div>
    );
}

function SectionHeader({ icon, title, action }: { icon: ReactNode; title: string; action?: ReactNode }) {
    return (
        <div className="flex items-center justify-between mb-4">
            <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                {icon}
                {title}
            </h2>
            {action}
        </div>
    );
}

function ChartCard({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <div className={cn("rounded-xl border border-border bg-card p-6 transition-all duration-300 hover:border-border/80", className)}>
            {children}
        </div>
    );
}

// ── Chart sections ───────────────────────────────────────────────

function GenreDistribution({ data }: { data: DashboardStats["genreStats"] }) {
    if (data.length === 0) return <EmptyChart message="No genre data yet" />;
    return (
        <ResponsiveContainer width="100%" height={280}>
            <BarChart data={data.slice(0, 10)} layout="vertical" margin={{ left: 10, right: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                <XAxis type="number" stroke="var(--muted-foreground)" fontSize={12} />
                <YAxis type="category" dataKey="genre" width={100} stroke="var(--muted-foreground)" fontSize={12} />
                <Tooltip {...TOOLTIP_STYLE} />
                <Bar dataKey="count" radius={[0, 4, 4, 0]} animationDuration={1200} animationBegin={300}>
                    {data.slice(0, 10).map((_, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                </Bar>
            </BarChart>
        </ResponsiveContainer>
    );
}

function EnergyDistribution({ data }: { data: DashboardStats["energyStats"] }) {
    if (data.length === 0) return <EmptyChart message="No energy data yet" />;
    const padded = Array.from({ length: 10 }, (_, i) => {
        const found = data.find((d) => d.energy === i + 1);
        return { energy: i + 1, label: `${i + 1}`, count: found?.count ?? 0 };
    });
    return (
        <ResponsiveContainer width="100%" height={280}>
            <BarChart data={padded} margin={{ left: -10, right: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" stroke="var(--muted-foreground)" fontSize={12} />
                <YAxis stroke="var(--muted-foreground)" fontSize={12} />
                <Tooltip {...TOOLTIP_STYLE} labelFormatter={(l) => `Energy ${l}`} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} animationDuration={1200} animationBegin={500}>
                    {padded.map((d) => (
                        <Cell key={d.energy} fill={ENERGY_HEX[d.energy] || "#8b5cf6"} />
                    ))}
                </Bar>
            </BarChart>
        </ResponsiveContainer>
    );
}

function BpmDistribution({ data }: { data: DashboardStats["bpmRanges"] }) {
    if (data.length === 0) return <EmptyChart message="No BPM data yet" />;
    return (
        <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data} margin={{ left: -10, right: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="range" stroke="var(--muted-foreground)" fontSize={12} />
                <YAxis stroke="var(--muted-foreground)" fontSize={12} />
                <Tooltip {...TOOLTIP_STYLE} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} animationDuration={1200} animationBegin={700}>
                    {data.map((_, i) => (
                        <Cell key={i} fill={BPM_GRADIENT[i % BPM_GRADIENT.length]} />
                    ))}
                </Bar>
            </BarChart>
        </ResponsiveContainer>
    );
}

function KeyDistribution({ data }: { data: DashboardStats["keyStats"] }) {
    if (data.length === 0) return <EmptyChart message="No key data yet" />;
    return (
        <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data.slice(0, 12)} layout="vertical" margin={{ left: 5, right: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                <XAxis type="number" stroke="var(--muted-foreground)" fontSize={12} />
                <YAxis type="category" dataKey="key" width={50} stroke="var(--muted-foreground)" fontSize={12} />
                <Tooltip {...TOOLTIP_STYLE} />
                <Bar dataKey="count" radius={[0, 4, 4, 0]} animationDuration={1200} animationBegin={700}>
                    {data.slice(0, 12).map((_, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                </Bar>
            </BarChart>
        </ResponsiveContainer>
    );
}

function EmptyChart({ message }: { message: string }) {
    return (
        <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
            <div className="text-center">
                <BarChart3 className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p>{message}</p>
                <p className="text-xs mt-1 opacity-70">Scan & analyze tracks to populate</p>
            </div>
        </div>
    );
}

// ── Library Health ───────────────────────────────────────────────

function LibraryHealth({ health }: { health: DashboardStats["health"] }) {
    const items = [
        { label: "Genre", icon: <Disc3 className="h-4 w-4" />, missing: health.missingGenre, color: "bg-purple-500" },
        { label: "BPM", icon: <Activity className="h-4 w-4" />, missing: health.missingBpm, color: "bg-blue-500" },
        { label: "Key", icon: <KeyRound className="h-4 w-4" />, missing: health.missingKey, color: "bg-cyan-500" },
        { label: "Energy", icon: <Zap className="h-4 w-4" />, missing: health.missingEnergy, color: "bg-amber-500" },
        { label: "Artwork", icon: <ImageOff className="h-4 w-4" />, missing: health.missingArtwork, color: "bg-rose-500" },
    ];
    const total = health.total;
    if (total === 0) {
        return (
            <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
                <div className="text-center">
                    <Shield className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    <p>No tracks to check</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {items.map((item) => {
                const filled = total - item.missing;
                const pct = Math.round((filled / total) * 100);
                return (
                    <div key={item.label} className="space-y-1.5">
                        <div className="flex items-center justify-between text-sm">
                            <span className="flex items-center gap-2 text-muted-foreground">
                                {item.icon}
                                {item.label}
                            </span>
                            <span className={cn("text-xs tabular-nums", pct === 100 ? "text-green-400" : pct > 70 ? "text-muted-foreground" : "text-amber-400")}>
                                {filled}/{total} ({pct}%)
                            </span>
                        </div>
                        <div className="h-2 rounded-full bg-muted overflow-hidden">
                            <div
                                className={cn("h-full rounded-full transition-all duration-1000 ease-out", item.color)}
                                style={{ width: `${pct}%`, transitionDelay: "500ms" }}
                            />
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

// ── Recently Added ───────────────────────────────────────────────

function RecentTracks({ tracks }: { tracks: DashboardStats["recentTracks"] }) {
    const { noteNotations } = useDAWSettings();
    if (tracks.length === 0) {
        return (
            <div className="flex h-[140px] items-center justify-center text-sm text-muted-foreground">
                <div className="text-center">
                    <Music className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    <p>No tracks yet</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-3 overflow-x-auto pb-2">
            {tracks.map((track, i) => (
                <div
                    key={track.id}
                    className="group/track shrink-0 w-44 rounded-lg border border-border bg-card/50 p-3 transition-all duration-300 hover:border-purple-500/30 hover:bg-card"
                    style={{ animationDelay: `${i * 60}ms` }}
                >
                    <div className="aspect-square rounded-md overflow-hidden bg-muted mb-2">
                        <Artwork src={track.artworkUrl} alt={track.title || ""} size="lg" className="h-full w-full rounded-md" />
                    </div>
                    <p className="text-sm font-medium truncate">{track.title || "Unknown"}</p>
                    <p className="text-xs text-muted-foreground truncate">{track.artist || "Unknown Artist"}</p>
                    <div className="flex flex-wrap gap-1 mt-2">
                        {track.bpm && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{Math.round(track.bpm)} BPM</Badge>}
                        {track.keyCamelot && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{formatKey(track.keyCamelot, noteNotations)}</Badge>}
                    </div>
                </div>
            ))}
        </div>
    );
}

// ── Top Rated ────────────────────────────────────────────────────

function TopRated({ tracks }: { tracks: DashboardStats["topRated"] }) {
    if (tracks.length === 0) {
        return (
            <div className="flex h-[120px] items-center justify-center text-sm text-muted-foreground">
                <div className="text-center">
                    <Star className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    <p>No rated tracks yet</p>
                    <p className="text-xs mt-1 opacity-70">Rate tracks 4-5 stars to see them here</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-2">
            {tracks.map((track) => (
                <div
                    key={track.id}
                    className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 transition-colors hover:bg-muted/50"
                >
                    <Artwork src={track.artworkUrl} alt={track.title || ""} size="sm" />
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{track.title || "Unknown"}</p>
                        <p className="text-xs text-muted-foreground truncate">{track.artist || "Unknown Artist"}</p>
                    </div>
                    <div className="flex gap-0.5">
                        {Array.from({ length: track.rating || 0 }, (_, i) => (
                            <Star key={i} className="h-3 w-3 fill-amber-400 text-amber-400" />
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

// ── Compact Recommendations ──────────────────────────────────────

function CompactRecommendations({ categories }: { categories: RecommendedCategory[] }) {
    const totalPlaylists = categories.reduce((a, c) => a + c.totalCount, 0);
    const existingCount = categories.reduce((a, c) => a + c.existingCount, 0);
    const missingCount = totalPlaylists - existingCount;
    const pct = totalPlaylists > 0 ? Math.round((existingCount / totalPlaylists) * 100) : 0;

    if (missingCount === 0) {
        return (
            <div className="flex items-center gap-3 rounded-lg border border-green-500/20 bg-green-500/5 p-4">
                <CheckCircle className="h-5 w-5 text-green-400 shrink-0" />
                <div>
                    <p className="text-sm font-medium text-green-400">All recommended playlists created</p>
                    <p className="text-xs text-muted-foreground">You have all {totalPlaylists} recommended playlists</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Progress bar */}
            <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Playlist setup progress</span>
                    <span className="tabular-nums font-medium">{existingCount}/{totalPlaylists}</span>
                </div>
                <div className="h-2.5 rounded-full bg-muted overflow-hidden">
                    <div
                        className="h-full rounded-full bg-gradient-to-r from-purple-500 to-violet-400 transition-all duration-1000 ease-out"
                        style={{ width: `${pct}%`, transitionDelay: "600ms" }}
                    />
                </div>
            </div>

            {/* Categories summary */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                {categories.map((cat) => {
                    const catMissing = cat.totalCount - cat.existingCount;
                    return (
                        <div
                            key={cat.category}
                            className={cn(
                                "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                                catMissing === 0
                                    ? "border-green-500/20 bg-green-500/5 text-green-400"
                                    : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/50"
                            )}
                        >
                            <span>{cat.icon}</span>
                            <span className="truncate">{cat.category}</span>
                            {catMissing > 0 && (
                                <Badge variant="secondary" className="ml-auto text-[10px] px-1.5 py-0 bg-amber-500/10 text-amber-400 border-amber-500/20">
                                    {catMissing}
                                </Badge>
                            )}
                            {catMissing === 0 && <CheckCircle className="h-3 w-3 ml-auto shrink-0" />}
                        </div>
                    );
                })}
            </div>

            <Link href="/playlists">
                <Button variant="outline" size="sm" className="gap-2 hover:border-purple-500/30 hover:text-purple-400">
                    <Sparkles className="h-4 w-4" />
                    Create {missingCount} missing playlists
                    <ArrowRight className="h-3 w-3" />
                </Button>
            </Link>
        </div>
    );
}

// ── Recent Activity ──────────────────────────────────────────────

function RecentActivity({ scans }: { scans: ScanLog[] }) {
    if (scans.length === 0) {
        return <p className="text-sm text-muted-foreground py-4">No recent activity.</p>;
    }

    const actionColors: Record<string, string> = {
        added: "bg-green-500",
        moved: "bg-blue-500",
        analysis_started: "bg-purple-500",
        analysis_completed: "bg-purple-400",
    };

    return (
        <div className="space-y-1.5 max-h-[280px] overflow-y-auto pr-1">
            {scans.map((log) => (
                <div
                    key={log.id}
                    className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/30 px-4 py-2 text-sm transition-colors hover:bg-muted/50"
                >
                    <div className="flex items-center gap-3 min-w-0">
                        <span className={cn("inline-block h-2 w-2 rounded-full shrink-0", actionColors[log.action] || "bg-yellow-500")} />
                        <span className="text-muted-foreground truncate">
                            {log.details || log.filepath}
                        </span>
                    </div>
                    <span className="text-xs text-muted-foreground/70 shrink-0 ml-4">
                        {log.scannedAt}
                    </span>
                </div>
            ))}
        </div>
    );
}

// ── Format Badges ────────────────────────────────────────────────

function FormatBadges({ data }: { data: DashboardStats["formatStats"] }) {
    if (data.length === 0) return null;
    return (
        <div className="flex flex-wrap gap-2">
            {data.map((f) => (
                <Badge key={f.format} variant="secondary" className="gap-1.5 text-xs">
                    <HardDrive className="h-3 w-3" />
                    {f.format.toUpperCase()}
                    <span className="text-muted-foreground">({f.count})</span>
                </Badge>
            ))}
        </div>
    );
}

// ── Greeting ─────────────────────────────────────────────────────

function getGreeting() {
    const h = new Date().getHours();
    if (h >= 5 && h < 12) return { text: "Good morning", emoji: "🌅" };
    if (h >= 12 && h < 18) return { text: "Good afternoon", emoji: "☀️" };
    if (h >= 18 && h < 22) return { text: "Good evening", emoji: "🌆" };
    return { text: "Night owl mode", emoji: "🌙" };
}

function formatTotalDuration(seconds: number) {
    if (!seconds) return "0h";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h === 0) return `${m}m`;
    return `${h}h ${m}m`;
}

// ── Main Dashboard ───────────────────────────────────────────────

export function DashboardClient({ stats, recommendedCategories, recentScans }: DashboardClientProps) {
    useRenderCount("Page:/");
    const greeting = getGreeting();

    return (
        <div className="flex flex-col h-full">
            {/* Sticky Header */}
            <div className="shrink-0 sticky top-0 z-20 bg-background/95 backdrop-blur-sm px-3 sm:px-4 md:px-6 pt-3 sm:pt-4 md:pt-6 pb-3 border-b border-border">
                <AnimatedSection delay={0}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                            <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
                                Dashboard
                                <span className="text-xl">{greeting.emoji}</span>
                            </h1>
                            <p className="text-muted-foreground mt-1">{greeting.text} — your library at a glance</p>
                        </div>
                        {stats.total > 0 && (
                            <div className="flex flex-wrap items-center gap-2">
                                <FormatBadges data={stats.formatStats} />
                                {stats.totalSize > 0 && (
                                    <Badge variant="secondary" className="gap-1.5 text-xs">
                                        <HardDrive className="h-3 w-3" />
                                        {formatBytes(stats.totalSize)}
                                    </Badge>
                                )}
                            </div>
                        )}
                    </div>
                </AnimatedSection>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-4 md:px-6 py-4 sm:py-5 md:py-6 space-y-6">

                {/* ── Stat Cards ──────────────────────────────────── */}
                <AnimatedSection delay={50}>
                    <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-6">
                        <StatCard
                            title="Total Tracks"
                            value={stats.total}
                            icon={<Music className="h-5 w-5" />}
                            theme="purple"
                            delay={100}
                        />
                        <StatCard
                            title="Analyzed"
                            value={stats.analyzed}
                            icon={<CheckCircle className="h-5 w-5" />}
                            description={stats.total > 0 ? `${Math.round((stats.analyzed / stats.total) * 100)}% of library` : undefined}
                            theme="green"
                            delay={150}
                        />
                        <StatCard
                            title="Avg BPM"
                            value={stats.avgBpm}
                            icon={<Activity className="h-5 w-5" />}
                            theme="blue"
                            delay={200}
                        />
                        <StatCard
                            title="Total Duration"
                            value={stats.totalDuration}
                            formattedValue={formatTotalDuration(stats.totalDuration)}
                            icon={<Clock className="h-5 w-5" />}
                            theme="cyan"
                            delay={250}
                            skipCountUp
                        />
                        <StatCard
                            title="Favorites"
                            value={stats.favorites}
                            icon={<Heart className="h-5 w-5" />}
                            theme="rose"
                            delay={300}
                        />
                        <StatCard
                            title="Playlists"
                            value={stats.playlistCount}
                            icon={<ListMusic className="h-5 w-5" />}
                            theme="amber"
                            delay={350}
                        />
                    </div>
                </AnimatedSection>

                {/* ── Quick Actions + Library Health ───────────────── */}
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                    <AnimatedSection delay={100}>
                        <ChartCard className="h-full">
                            <SectionHeader
                                icon={<Zap className="h-5 w-5 text-purple-400" />}
                                title="Quick Actions"
                            />
                            <DashboardActions />
                        </ChartCard>
                    </AnimatedSection>
                    <AnimatedSection delay={150}>
                        <ChartCard className="h-full">
                            <SectionHeader
                                icon={<Shield className="h-5 w-5 text-green-400" />}
                                title="Library Health"
                            />
                            <LibraryHealth health={stats.health} />
                        </ChartCard>
                    </AnimatedSection>
                </div>

                {/* ── Genre + Energy Charts ───────────────────────── */}
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                    <AnimatedSection delay={200}>
                        <ChartCard>
                            <SectionHeader
                                icon={<Disc3 className="h-5 w-5 text-purple-400" />}
                                title="Genre Distribution"
                            />
                            <GenreDistribution data={stats.genreStats} />
                        </ChartCard>
                    </AnimatedSection>
                    <AnimatedSection delay={250}>
                        <ChartCard>
                            <SectionHeader
                                icon={<Zap className="h-5 w-5 text-amber-400" />}
                                title="Energy Levels"
                            />
                            <EnergyDistribution data={stats.energyStats} />
                        </ChartCard>
                    </AnimatedSection>
                </div>

                {/* ── BPM + Key Charts ────────────────────────────── */}
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                    <AnimatedSection delay={300}>
                        <ChartCard>
                            <SectionHeader
                                icon={<TrendingUp className="h-5 w-5 text-blue-400" />}
                                title="BPM Ranges"
                            />
                            <BpmDistribution data={stats.bpmRanges} />
                        </ChartCard>
                    </AnimatedSection>
                    <AnimatedSection delay={350}>
                        <ChartCard>
                            <SectionHeader
                                icon={<KeyRound className="h-5 w-5 text-cyan-400" />}
                                title="Key Distribution"
                            />
                            <KeyDistribution data={stats.keyStats} />
                        </ChartCard>
                    </AnimatedSection>
                </div>

                {/* ── Recently Added ──────────────────────────────── */}
                <AnimatedSection delay={350}>
                    <ChartCard>
                        <SectionHeader
                            icon={<Music className="h-5 w-5 text-blue-400" />}
                            title="Recently Added"
                            action={
                                stats.recentTracks.length > 0 ? (
                                    <Link href="/library?sort=addedAt&order=desc">
                                        <Button variant="ghost" size="sm" className="gap-1 text-xs text-muted-foreground hover:text-foreground">
                                            View all <ChevronRight className="h-3 w-3" />
                                        </Button>
                                    </Link>
                                ) : undefined
                            }
                        />
                        <RecentTracks tracks={stats.recentTracks} />
                    </ChartCard>
                </AnimatedSection>

                {/* ── Top Rated + Playlist Recommendations ────────── */}
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                    <AnimatedSection delay={400}>
                        <ChartCard className="h-full">
                            <SectionHeader
                                icon={<Star className="h-5 w-5 text-amber-400" />}
                                title="Top Rated"
                            />
                            <TopRated tracks={stats.topRated} />
                        </ChartCard>
                    </AnimatedSection>
                    <AnimatedSection delay={450}>
                        <ChartCard className="h-full">
                            <SectionHeader
                                icon={<Sparkles className="h-5 w-5 text-violet-400" />}
                                title="Playlist Recommendations"
                                action={
                                    <Link href="/playlists">
                                        <Button variant="ghost" size="sm" className="gap-1 text-xs text-muted-foreground hover:text-foreground">
                                            Manage <ChevronRight className="h-3 w-3" />
                                        </Button>
                                    </Link>
                                }
                            />
                            <CompactRecommendations categories={recommendedCategories} />
                        </ChartCard>
                    </AnimatedSection>
                </div>

                {/* ── Recent Activity ─────────────────────────────── */}
                <AnimatedSection delay={500}>
                    <ChartCard>
                        <SectionHeader
                            icon={<Activity className="h-5 w-5 text-green-400" />}
                            title="Recent Activity"
                        />
                        <RecentActivity scans={recentScans} />
                    </ChartCard>
                </AnimatedSection>
            </div>
        </div>
    );
}
