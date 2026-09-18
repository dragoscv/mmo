"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Page, PageHeader } from "@mmo/ui";
import { Input } from "@/components/ui/input";
import { formatNumber } from "@/lib/utils";
import { useRenderCount } from "@/lib/dev-debugger";
import {
    Search,
    X,
    ChevronLeft,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
    ArrowLeft,
    EyeOff,
} from "lucide-react";
import Link from "next/link";
import type { Track } from "@/db/schema";
import { HiddenTable } from "./hidden-table";

interface HiddenClientProps {
    tracks: Track[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    search: string;
}

export function HiddenClient({
    tracks,
    total,
    page,
    pageSize,
    totalPages,
    search,
}: HiddenClientProps) {
    useRenderCount("Page:/library/hidden");
    const t = useTranslations("tables.hidden");
    const router = useRouter();
    const searchParams = useSearchParams();
    const [searchInput, setSearchInput] = useState(search);

    function navigate(updates: Record<string, string | undefined>) {
        const params = new URLSearchParams(searchParams.toString());
        for (const [key, value] of Object.entries(updates)) {
            if (value) params.set(key, value);
            else params.delete(key);
        }
        router.push(`/library/hidden?${params.toString()}`);
    }

    function handleSearch() {
        navigate({ search: searchInput || undefined, page: "1" });
    }

    function handlePageChange(newPage: number) {
        navigate({ page: String(newPage) });
    }

    return (
        <Page width="xl" className="flex flex-col gap-4">
            <PageHeader
                className="mb-0"
                eyebrow={
                    <Link href="/library" className="inline-flex items-center gap-1.5 normal-case tracking-normal transition-colors hover:text-foreground">
                        <ArrowLeft className="h-3.5 w-3.5" />
                        {t("back")}
                    </Link>
                }
                title={
                    <span className="inline-flex items-center gap-2">
                        <EyeOff className="h-6 w-6 text-warning" aria-hidden />
                        {t("title")}
                    </span>
                }
                description={t("count", { count: total })}
            />

            {/* Search */}
            <div className="flex flex-wrap items-center gap-2">
                <form
                    onSubmit={(e) => { e.preventDefault(); handleSearch(); }}
                    className="flex items-center gap-2"
                >
                    <Input
                        placeholder={t("searchPlaceholder")}
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        className="w-full max-w-64 h-8"
                    />
                    <Button type="submit" size="icon-sm" variant="outline" aria-label={t("searchPlaceholder")}>
                        <Search />
                    </Button>
                    {search && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => { setSearchInput(""); navigate({ search: undefined, page: "1" }); }}
                        >
                            <X />
                            {t("clear")}
                        </Button>
                    )}
                </form>

                <span className="ml-auto text-xs text-muted-foreground">
                    {total > 0
                        ? t("range", { from: (page - 1) * pageSize + 1, to: Math.min(page * pageSize, total), total: formatNumber(total) })
                        : t("empty")}
                </span>
            </div>

            <HiddenTable tracks={tracks} />

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                        {t("page", { page, total: totalPages })}
                    </span>
                    <div className="flex items-center gap-1">
                        <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => handlePageChange(1)}>
                            <ChevronsLeft />
                        </Button>
                        <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => handlePageChange(page - 1)}>
                            <ChevronLeft />
                        </Button>
                        <Button variant="outline" size="icon-sm" disabled={page >= totalPages} onClick={() => handlePageChange(page + 1)}>
                            <ChevronRight />
                        </Button>
                        <Button variant="outline" size="icon-sm" disabled={page >= totalPages} onClick={() => handlePageChange(totalPages)}>
                            <ChevronsRight />
                        </Button>
                    </div>
                </div>
            )}
        </Page>
    );
}
