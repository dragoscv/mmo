"use client";

import {
    AreaChart,
    Area,
    XAxis,
    YAxis,
    Tooltip,
    ResponsiveContainer,
    CartesianGrid,
} from "recharts";

const TOOLTIP_STYLE = {
    contentStyle: {
        background: "var(--card)",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        color: "var(--foreground)",
        fontSize: "12px",
    },
};

export function WatchDailyChart({ data }: { data: Array<{ day: string; minutes: number }> }) {
    return (
        <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                    <linearGradient id="watchGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#a855f7" stopOpacity={0.6} />
                        <stop offset="100%" stopColor="#a855f7" stopOpacity={0} />
                    </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="day" stroke="var(--muted-foreground)" fontSize={11} />
                <YAxis stroke="var(--muted-foreground)" fontSize={11} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v) => [`${v} min`, "Watched"] as [string, string]} />
                <Area type="monotone" dataKey="minutes" stroke="#a855f7" fill="url(#watchGrad)" strokeWidth={2} />
            </AreaChart>
        </ResponsiveContainer>
    );
}
