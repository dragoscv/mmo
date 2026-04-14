"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

const COLORS = [
  "#8b5cf6",
  "#22c55e",
  "#3b82f6",
  "#ef4444",
  "#eab308",
  "#f97316",
  "#06b6d4",
  "#ec4899",
  "#14b8a6",
  "#a855f7",
];

interface GenreChartProps {
  data: { genre: string; count: number }[];
}

export function GenreChart({ data }: GenreChartProps) {
  return (
    <ResponsiveContainer width="100%" height={250}>
      <BarChart data={data} layout="vertical" margin={{ left: 10 }}>
        <XAxis type="number" stroke="var(--muted-foreground)" fontSize={12} />
        <YAxis
          type="category"
          dataKey="genre"
          width={100}
          stroke="var(--muted-foreground)"
          fontSize={12}
        />
        <Tooltip
          contentStyle={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: "8px",
            color: "var(--foreground)",
          }}
        />
        <Bar dataKey="count" radius={[0, 4, 4, 0]}>
          {data.map((_, index) => (
            <Cell key={index} fill={COLORS[index % COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
