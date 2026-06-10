import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { BookOpen, ChevronRight } from "lucide-react";
import { listSections } from "@/lib/learn";

export const dynamic = "force-static";

export default async function LearnIndexPage() {
    const t = await getTranslations("learn");
    const sections = listSections();

    return (
        <div className="mx-auto max-w-5xl px-4 py-8 space-y-8">
            <header className="space-y-2">
                <div className="inline-flex items-center gap-2 text-xs uppercase tracking-wider text-[var(--muted-foreground)]">
                    <BookOpen className="h-3.5 w-3.5" />
                    {t("eyebrow")}
                </div>
                <h1 className="text-3xl font-semibold">{t("title")}</h1>
                <p className="text-[var(--muted-foreground)] max-w-2xl">{t("subtitle")}</p>
            </header>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {sections.map((s) => (
                    <Link
                        key={s.slug}
                        href={`/learn/${s.slug}`}
                        className="group rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 hover:border-[var(--primary)] transition-colors"
                    >
                        <div className="flex items-start justify-between gap-3">
                            <div className="space-y-1 min-w-0">
                                <h2 className="font-medium">{t(s.title)}</h2>
                                <p className="text-sm text-[var(--muted-foreground)] line-clamp-2">
                                    {t(s.description)}
                                </p>
                            </div>
                            <ChevronRight className="h-4 w-4 text-[var(--muted-foreground)] group-hover:text-[var(--primary)] transition-colors flex-shrink-0" />
                        </div>
                        <div className="mt-3 text-xs text-[var(--muted-foreground)]">
                            {t("pageCount", { count: s.pageCount })}
                        </div>
                    </Link>
                ))}
            </div>
        </div>
    );
}
