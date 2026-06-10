"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback, useTransition } from "react";

interface Props {
    /** Distinct genre names available across the dataset. */
    genres: string[];
    /** Distinct years available, descending. */
    years: number[];
    /** Total count after filtering, shown next to the title. */
    count: number;
}

const SORT_OPTIONS = [
    { value: "added_desc", label: "Recent added" },
    { value: "added_asc", label: "Oldest added" },
    { value: "title_asc", label: "Title A→Z" },
    { value: "title_desc", label: "Title Z→A" },
    { value: "year_desc", label: "Newest" },
    { value: "year_asc", label: "Oldest" },
    { value: "rating_desc", label: "Top rated" },
] as const;

export function WatchFilterBar({ genres, years, count }: Props) {
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const [pending, startTransition] = useTransition();

    const update = useCallback(
        (key: string, value: string | null) => {
            const next = new URLSearchParams(params);
            if (value && value !== "") next.set(key, value);
            else next.delete(key);
            startTransition(() => {
                router.push(`${pathname}?${next.toString()}`, { scroll: false });
            });
        },
        [params, pathname, router],
    );

    const clearAll = useCallback(() => {
        startTransition(() => router.push(pathname, { scroll: false }));
    }, [pathname, router]);

    const hasAny = ["genre", "year", "minRating", "sort", "q"].some((k) => params.get(k));

    return (
        <div className="watch-filter-bar">
            <div className="watch-filter-row">
                <input
                    className="watch-filter-search"
                    type="search"
                    placeholder="Search title…"
                    defaultValue={params.get("q") ?? ""}
                    onChange={(e) => update("q", e.target.value)}
                />
                <select
                    className="watch-filter-select"
                    value={params.get("genre") ?? ""}
                    onChange={(e) => update("genre", e.target.value || null)}
                >
                    <option value="">All genres</option>
                    {genres.map((g) => (
                        <option key={g} value={g}>{g}</option>
                    ))}
                </select>
                <select
                    className="watch-filter-select"
                    value={params.get("year") ?? ""}
                    onChange={(e) => update("year", e.target.value || null)}
                >
                    <option value="">All years</option>
                    {years.map((y) => (
                        <option key={y} value={y}>{y}</option>
                    ))}
                </select>
                <select
                    className="watch-filter-select"
                    value={params.get("minRating") ?? ""}
                    onChange={(e) => update("minRating", e.target.value || null)}
                >
                    <option value="">Any rating</option>
                    <option value="9">★ 9+</option>
                    <option value="8">★ 8+</option>
                    <option value="7">★ 7+</option>
                    <option value="6">★ 6+</option>
                    <option value="5">★ 5+</option>
                </select>
                <select
                    className="watch-filter-select"
                    value={params.get("sort") ?? "added_desc"}
                    onChange={(e) => update("sort", e.target.value === "added_desc" ? null : e.target.value)}
                >
                    {SORT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>
                {hasAny && (
                    <button type="button" className="watch-filter-clear" onClick={clearAll}>
                        Clear
                    </button>
                )}
                <span className="watch-filter-count" aria-live="polite">
                    {pending ? "…" : `${count} result${count === 1 ? "" : "s"}`}
                </span>
            </div>
        </div>
    );
}
