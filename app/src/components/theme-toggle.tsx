"use client";

import { useTheme } from "@/components/theme-provider";
import { useEffect, useState } from "react";
import { Sun, Moon, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";

export function ThemeToggle({ collapsed }: { collapsed?: boolean } = {}) {
    const { theme, setTheme } = useTheme();
    const [mounted, setMounted] = useState(false);

    useEffect(() => setMounted(true), []);

    if (!mounted) {
        return <div className="h-8 w-8" />;
    }

    const options = [
        { value: "light", icon: Sun, label: "Light" },
        { value: "dark", icon: Moon, label: "Dark" },
        { value: "system", icon: Monitor, label: "System" },
    ] as const;

    return (
        <div className={cn(
            "flex gap-0.5 rounded-lg bg-muted p-0.5",
            collapsed ? "flex-col" : "items-center"
        )}>
            {options.map(({ value, icon: Icon, label }) => (
                <button
                    key={value}
                    onClick={() => setTheme(value)}
                    className={cn(
                        "flex h-7 w-7 items-center justify-center rounded-md transition-colors cursor-pointer",
                        theme === value
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                    )}
                    title={label}
                >
                    <Icon className="h-3.5 w-3.5" />
                </button>
            ))}
        </div>
    );
}
