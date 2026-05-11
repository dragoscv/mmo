"use client";

/**
 * Dashboard chart components, split into a separate module so the
 * recharts dependency (~90 KB gzipped) can be code-split out of the
 * dashboard's initial bundle via `next/dynamic` in dashboard-client.tsx.
 *
 * Keep this file pure presentational — no data fetching, no global
 * state. Inputs come from the parent's already-fetched DashboardStats.
 */

import { useTranslations } from "next-intl";
import { BarChart3 } from "lucide-react";
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    Tooltip,
    ResponsiveContainer,
    Cell,
    CartesianGrid,
    Area,
    AreaChart,
} from "recharts";
import type { DashboardStats } from "@/actions/tracks";

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

const TOOLTIP_STYLE = {
    contentStyle: {
        background: "var(--card)",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        color: "var(--foreground)",
        fontSize: "12px",
    },
};

function EmptyChart({ message }: { message: string }) {
    const t = useTranslations("dashboard.empty");
    return (
        <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
            <div className="text-center">
                <BarChart3 className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p>{message}</p>
                <p className="text-xs mt-1 opacity-70">{t("scanToPopulate")}</p>
            </div>
        </div>
    );
}

export function GenreDistribution({ data }: { data: DashboardStats["genreStats"] }) {
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

export function EnergyDistribution({ data }: { data: DashboardStats["energyStats"] }) {
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

export function BpmDistribution({ data }: { data: DashboardStats["bpmRanges"] }) {
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

export function KeyDistribution({ data }: { data: DashboardStats["keyStats"] }) {
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

/** Library growth — tracks added per day over the last N days.
 *  Renders as a smooth area chart so quiet days don't visually
 *  shout (vs. a bar chart full of empty columns). */
export function LibraryGrowth({ data }: { data: Array<{ date: string; added: number }> }) {
    if (data.length === 0) return <EmptyChart message="No growth data yet" />;
    const total = data.reduce((sum, d) => sum + d.added, 0);
    if (total === 0) return <EmptyChart message="No tracks added in this window" />;
    return (
        <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={data} margin={{ left: 5, right: 15, top: 10, bottom: 0 }}>
                <defs>
                    <linearGradient id="growthGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.55} />
                        <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0.04} />
                    </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                    dataKey="date"
                    stroke="var(--muted-foreground)"
                    fontSize={11}
                    tickFormatter={(d: string) => d.slice(5)} /* MM-DD */
                    interval={Math.max(0, Math.floor(data.length / 8) - 1)}
                />
                <YAxis stroke="var(--muted-foreground)" fontSize={11} allowDecimals={false} width={30} />
                <Tooltip {...TOOLTIP_STYLE} />
                <Area
                    type="monotone"
                    dataKey="added"
                    stroke="#a855f7"
                    strokeWidth={2}
                    fill="url(#growthGradient)"
                    animationDuration={1200}
                    animationBegin={500}
                />
            </AreaChart>
        </ResponsiveContainer>
    );
}
