import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface StatsCardProps {
    title: string;
    value: string | number;
    description?: string;
    icon: ReactNode;
    className?: string;
}

export function StatsCard({
    title,
    value,
    description,
    icon,
    className,
}: StatsCardProps) {
    return (
        <div
            className={cn(
                "group relative rounded-xl border border-border bg-card p-6 transition-all duration-300",
                "hover:border-purple-500/20 hover:shadow-[0_0_20px_rgba(139,92,246,0.06)]",
                className
            )}
        >
            {/* Subtle gradient on hover */}
            <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-purple-500/[0.03] to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

            <div className="relative flex items-center justify-between">
                <p className="text-sm font-medium text-muted-foreground">
                    {title}
                </p>
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground group-hover:bg-purple-500/10 group-hover:text-purple-400 transition-all duration-300">
                    {icon}
                </div>
            </div>
            <div className="relative mt-3">
                <p className="text-3xl font-bold tracking-tight">{value}</p>
                {description && (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                        {description}
                    </p>
                )}
            </div>
        </div>
    );
}
