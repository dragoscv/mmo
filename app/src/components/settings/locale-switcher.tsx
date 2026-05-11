"use client";

import { useTransition } from "react";
import { Languages } from "lucide-react";
import { setLocaleAction } from "@/actions/locale";
import { SUPPORTED_LOCALES, type AppLocale } from "@/i18n/locales";
import { cn } from "@/lib/utils";

const LOCALE_LABELS: Record<AppLocale, string> = {
    ro: "Română",
    en: "English",
};

export function LocaleSwitcher({ current }: { current: AppLocale }) {
    const [pending, startTransition] = useTransition();

    return (
        <section className="rounded-xl border border-border bg-card p-5 space-y-4">
            <header className="flex items-center gap-2">
                <Languages className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-base font-semibold">Limbă / Language</h2>
            </header>
            <p className="text-sm text-muted-foreground">
                Schimbă limba interfeței. Opțiunea se memorează într-un cookie
                (<code className="rounded bg-muted px-1 py-0.5 text-xs">mmo-locale</code>) și
                se aplică tuturor paginilor.
            </p>
            <div className="flex flex-wrap gap-2">
                {SUPPORTED_LOCALES.map((loc) => {
                    const isActive = loc === current;
                    return (
                        <button
                            key={loc}
                            type="button"
                            disabled={pending || isActive}
                            onClick={() => startTransition(() => { setLocaleAction(loc); })}
                            className={cn(
                                "rounded-lg border px-4 py-2 text-sm font-medium transition-colors",
                                isActive
                                    ? "border-purple-400 bg-purple-500/10 text-purple-200"
                                    : "border-border bg-background hover:bg-muted",
                                pending && "opacity-60 cursor-progress",
                            )}
                            aria-pressed={isActive}
                        >
                            {LOCALE_LABELS[loc]}
                            {isActive && <span className="ml-2 text-xs text-muted-foreground">activ</span>}
                        </button>
                    );
                })}
            </div>
        </section>
    );
}
