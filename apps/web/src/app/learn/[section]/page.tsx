import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { LEARN_SECTION_SLUGS, listSectionPages } from "@/lib/learn";

export const dynamic = "force-static";

export function generateStaticParams() {
    return LEARN_SECTION_SLUGS.map((section) => ({ section }));
}

interface Props {
    params: Promise<{ section: string }>;
}

export default async function LearnSectionPage({ params }: Props) {
    const { section } = await params;
    if (!LEARN_SECTION_SLUGS.includes(section)) notFound();

    const t = await getTranslations("learn");
    const pages = listSectionPages(section);
    if (pages.length === 0) notFound();

    return (
        <div className="mx-auto max-w-5xl px-4 py-8 space-y-6">
            <Link
                href="/learn"
                className="inline-flex items-center gap-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
                <ChevronLeft className="h-4 w-4" />
                {t("backToIndex")}
            </Link>

            <header className="space-y-2">
                <h1 className="text-3xl font-semibold">{t(`sections.${section}.title`)}</h1>
                <p className="text-[var(--muted-foreground)] max-w-2xl">
                    {t(`sections.${section}.desc`)}
                </p>
            </header>

            <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
                {pages.map((p) => (
                    <li key={p.slug}>
                        <Link
                            href={`/learn/${section}/${p.slug}`}
                            className="flex items-center justify-between gap-3 p-3 hover:bg-[var(--accent)] transition-colors"
                        >
                            <div className="flex items-center gap-3 min-w-0">
                                <FileText className="h-4 w-4 text-[var(--muted-foreground)] flex-shrink-0" />
                                <span className="truncate">{p.title}</span>
                            </div>
                            <ChevronRight className="h-4 w-4 text-[var(--muted-foreground)] flex-shrink-0" />
                        </Link>
                    </li>
                ))}
            </ul>
        </div>
    );
}
