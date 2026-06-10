"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import {
    Disc3, Piano, Waves, Plug, CircleDot, Mic, Music2,
    Clock, HardDrive, Star, Sparkles, ArrowRight, Activity,
    Lightbulb, TrendingUp,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RecordingSource } from "@/actions/recordings";

export interface MusicSourceStat {
    source: RecordingSource;
    count: number;
    bytes: number;
    durationMs: number;
}

interface RecentItem {
    id: number;
    name: string;
    source: string;
    durationMs: number;
    sizeBytes: number;
    createdAt: string | null;
    isFavorite: boolean;
}

interface Props {
    totals: {
        recordings: number;
        bytes: number;
        durationMs: number;
        favorites: number;
        lastAt: string | null;
    };
    sourceStats: MusicSourceStat[];
    recent: RecentItem[];
}

const APPS: Array<{
    href: string;
    label: string;
    description: string;
    icon: LucideIcon;
    gradient: string;
    ring: string;
}> = [
    {
        href: "/mixer", label: "Mixer", icon: Disc3,
        description: "Two-deck DJ mixer with sync, EQ, FX and crossfader.",
        gradient: "from-violet-500/20 to-fuchsia-500/10",
        ring: "ring-violet-400/30",
    },
    {
        href: "/daw", label: "DAW", icon: Piano,
        description: "Multi-track digital audio workstation for production.",
        gradient: "from-emerald-500/20 to-teal-500/10",
        ring: "ring-emerald-400/30",
    },
    {
        href: "/editor", label: "Sound Editor", icon: Waves,
        description: "Precise waveform editing, trim, fade and effects.",
        gradient: "from-amber-500/20 to-orange-500/10",
        ring: "ring-amber-400/30",
    },
    {
        href: "/plugins", label: "Plugins", icon: Plug,
        description: "Browse and manage VST / AU instruments and effects.",
        gradient: "from-sky-500/20 to-blue-500/10",
        ring: "ring-sky-400/30",
    },
    {
        href: "/recordings", label: "Recordings", icon: CircleDot,
        description: "All your captured takes from Live, Mixer, DAW and Editor.",
        gradient: "from-rose-500/20 to-pink-500/10",
        ring: "ring-rose-400/30",
    },
];

const SOURCE_META: Record<RecordingSource, { label: string; icon: LucideIcon; color: string }> = {
    live:   { label: "Live",   icon: Mic,   color: "text-rose-300" },
    mixer:  { label: "Mixer",  icon: Disc3, color: "text-violet-300" },
    daw:    { label: "DAW",    icon: Piano, color: "text-emerald-300" },
    editor: { label: "Editor", icon: Waves, color: "text-amber-300" },
};

function formatBytes(b: number): string {
    if (!b) return "0 B";
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function formatRelative(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} d ago`;
    return d.toLocaleDateString();
}

function buildRecommendations(props: Props): Array<{ title: string; body: string; href: string; cta: string }> {
    const recs: Array<{ title: string; body: string; href: string; cta: string }> = [];
    const { totals, sourceStats } = props;
    const top = [...sourceStats].sort((a, b) => b.count - a.count)[0];
    const idle = sourceStats.filter((s) => s.count === 0);

    if (totals.recordings === 0) {
        recs.push({
            title: "Make your first recording",
            body: "Open the Mixer or Live module and hit record — captures auto-save here.",
            href: "/mixer", cta: "Open Mixer",
        });
    } else if (top && top.count > 0) {
        recs.push({
            title: `You record a lot from ${SOURCE_META[top.source].label}`,
            body: `Review and tag your latest ${SOURCE_META[top.source].label.toLowerCase()} takes to keep the library clean.`,
            href: "/recordings", cta: "Open Recordings",
        });
    }

    if (idle.length > 0 && idle.length < sourceStats.length) {
        const target = idle[0];
        recs.push({
            title: `Try the ${SOURCE_META[target.source].label} module`,
            body: `You haven't recorded anything from ${SOURCE_META[target.source].label} yet — give it a spin.`,
            href: target.source === "live" ? "/live" : `/${target.source}`,
            cta: `Open ${SOURCE_META[target.source].label}`,
        });
    }

    if (totals.bytes > 5 * 1024 * 1024 * 1024) {
        recs.push({
            title: "Storage is getting large",
            body: `You're at ${formatBytes(totals.bytes)} of recordings. Consider archiving favorites and removing rough takes.`,
            href: "/recordings", cta: "Manage Recordings",
        });
    }

    recs.push({
        title: "Sharpen your skills",
        body: "Short, focused lessons on mixing, beatmatching and production fundamentals.",
        href: "/learn", cta: "Open Learn",
    });

    return recs.slice(0, 4);
}

export function MusicDashboardClient(props: Props) {
    const { totals, sourceStats, recent } = props;
    const recs = buildRecommendations(props);
    const maxCount = Math.max(1, ...sourceStats.map((s) => s.count));

    return (
        <div className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-10">
            {/* Hero */}
            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35 }}
                className="relative overflow-hidden rounded-2xl border border-white/5 bg-gradient-to-br from-cyan-500/10 via-blue-500/5 to-transparent p-6 md:p-8"
            >
                <div className="absolute -right-20 -top-20 size-72 rounded-full bg-cyan-500/10 blur-3xl" />
                <div className="absolute -left-16 -bottom-24 size-72 rounded-full bg-blue-500/10 blur-3xl" />
                <div className="relative flex items-start gap-4">
                    <div className="flex size-12 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 to-blue-500 shadow-lg shadow-cyan-500/20">
                        <Music2 className="size-6 text-white" />
                    </div>
                    <div className="flex-1">
                        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Music</h1>
                        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                            Your creative hub — apps, recent recordings, statistics and personalized recommendations.
                        </p>
                    </div>
                </div>

                {/* KPI row */}
                <div className="relative mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
                    <KpiCard icon={CircleDot} label="Recordings" value={totals.recordings.toString()} />
                    <KpiCard icon={Clock} label="Total length" value={formatDuration(totals.durationMs)} />
                    <KpiCard icon={HardDrive} label="Storage" value={formatBytes(totals.bytes)} />
                    <KpiCard icon={Star} label="Favorites" value={totals.favorites.toString()} hint={totals.lastAt ? `Last activity ${formatRelative(totals.lastAt)}` : undefined} />
                </div>
            </motion.div>

            {/* Apps */}
            <section className="mt-10">
                <SectionHeader icon={Sparkles} title="Music apps" subtitle="Jump straight into the tool you need." />
                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {APPS.map((app, i) => (
                        <motion.div
                            key={app.href}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.25, delay: i * 0.04 }}
                        >
                            <Link
                                href={app.href}
                                className={cn(
                                    "group relative flex h-full flex-col gap-3 overflow-hidden rounded-xl border border-white/5 bg-card/50 p-4 ring-1 ring-transparent transition",
                                    "hover:border-white/10 hover:bg-card/80 hover:shadow-lg",
                                    app.ring,
                                )}
                            >
                                <div className={cn("pointer-events-none absolute inset-0 bg-gradient-to-br opacity-60", app.gradient)} />
                                <div className="relative flex items-center gap-3">
                                    <div className="flex size-10 items-center justify-center rounded-lg bg-background/60 ring-1 ring-white/10">
                                        <app.icon className="size-5" />
                                    </div>
                                    <div className="flex-1">
                                        <div className="text-sm font-medium">{app.label}</div>
                                    </div>
                                    <ArrowRight className="size-4 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" />
                                </div>
                                <p className="relative text-xs text-muted-foreground">{app.description}</p>
                            </Link>
                        </motion.div>
                    ))}
                </div>
            </section>

            {/* Stats + Recent */}
            <section className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-5">
                <div className="lg:col-span-3">
                    <SectionHeader icon={Activity} title="Activity by source" subtitle="Where your recordings come from." />
                    <div className="mt-4 rounded-xl border border-white/5 bg-card/40 p-4">
                        {sourceStats.every((s) => s.count === 0) ? (
                            <EmptyHint>No recordings yet. Start a session in Mixer, DAW, Live or Sound Editor.</EmptyHint>
                        ) : (
                            <ul className="space-y-3">
                                {sourceStats.map((s) => {
                                    const meta = SOURCE_META[s.source];
                                    const pct = Math.round((s.count / maxCount) * 100);
                                    return (
                                        <li key={s.source} className="flex items-center gap-3">
                                            <div className="flex w-28 items-center gap-2">
                                                <meta.icon className={cn("size-4", meta.color)} />
                                                <span className="text-sm">{meta.label}</span>
                                            </div>
                                            <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-white/5">
                                                <motion.div
                                                    initial={{ width: 0 }}
                                                    animate={{ width: `${pct}%` }}
                                                    transition={{ duration: 0.6, ease: [0.32, 0.72, 0, 1] }}
                                                    className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-cyan-400 to-blue-500"
                                                />
                                            </div>
                                            <div className="w-32 text-right text-xs text-muted-foreground">
                                                {s.count} · {formatDuration(s.durationMs)}
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </div>

                <div className="lg:col-span-2">
                    <SectionHeader icon={TrendingUp} title="Recent recordings" subtitle="Your latest captures." />
                    <div className="mt-4 rounded-xl border border-white/5 bg-card/40 p-2">
                        {recent.length === 0 ? (
                            <EmptyHint>Nothing recorded yet.</EmptyHint>
                        ) : (
                            <ul className="divide-y divide-white/5">
                                {recent.map((r) => {
                                    const meta = SOURCE_META[(r.source as RecordingSource)] ?? SOURCE_META.live;
                                    return (
                                        <li key={r.id}>
                                            <Link
                                                href={`/recordings#rec-${r.id}`}
                                                className="flex items-center gap-3 rounded-lg px-3 py-2 transition hover:bg-white/5"
                                            >
                                                <meta.icon className={cn("size-4 shrink-0", meta.color)} />
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate text-sm">{r.name}</div>
                                                    <div className="truncate text-xs text-muted-foreground">
                                                        {formatDuration(r.durationMs)} · {formatBytes(r.sizeBytes)} · {formatRelative(r.createdAt)}
                                                    </div>
                                                </div>
                                                {r.isFavorite && <Star className="size-3.5 text-amber-300" />}
                                            </Link>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </div>
            </section>

            {/* Recommendations */}
            <section className="mt-10 mb-4">
                <SectionHeader icon={Lightbulb} title="Recommendations" subtitle="Tailored to your activity." />
                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                    {recs.map((r, i) => (
                        <motion.div
                            key={r.title}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.25, delay: i * 0.04 }}
                            className="rounded-xl border border-white/5 bg-card/40 p-4"
                        >
                            <div className="flex items-start gap-3">
                                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-400/20 to-blue-500/10 ring-1 ring-cyan-400/20">
                                    <Sparkles className="size-4 text-cyan-300" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium">{r.title}</div>
                                    <p className="mt-1 text-xs text-muted-foreground">{r.body}</p>
                                    <Link
                                        href={r.href}
                                        className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-cyan-300 hover:text-cyan-200"
                                    >
                                        {r.cta} <ArrowRight className="size-3" />
                                    </Link>
                                </div>
                            </div>
                        </motion.div>
                    ))}
                </div>
            </section>
        </div>
        </div>
    );
}

function KpiCard({
    icon: Icon, label, value, hint,
}: { icon: LucideIcon; label: string; value: string; hint?: string }) {
    return (
        <div className="rounded-xl border border-white/5 bg-background/40 p-3 backdrop-blur">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Icon className="size-3.5" />
                <span>{label}</span>
            </div>
            <div className="mt-1 text-xl font-semibold tracking-tight">{value}</div>
            {hint && <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>}
        </div>
    );
}

function SectionHeader({
    icon: Icon, title, subtitle,
}: { icon: LucideIcon; title: string; subtitle?: string }) {
    return (
        <div className="flex items-end justify-between gap-3">
            <div>
                <div className="flex items-center gap-2">
                    <Icon className="size-4 text-muted-foreground" />
                    <h2 className="text-base font-semibold tracking-tight">{title}</h2>
                </div>
                {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
            </div>
        </div>
    );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
    return <div className="px-2 py-6 text-center text-xs text-muted-foreground">{children}</div>;
}
