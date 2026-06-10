import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ChevronLeft } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LEARN_SECTION_SLUGS, listSectionPages, getPage } from "@/lib/learn";

export const dynamic = "force-static";

export function generateStaticParams() {
    const out: { section: string; slug: string }[] = [];
    for (const section of LEARN_SECTION_SLUGS) {
        for (const page of listSectionPages(section)) {
            out.push({ section, slug: page.slug });
        }
    }
    return out;
}

interface Props {
    params: Promise<{ section: string; slug: string }>;
}

export default async function LearnPagePage({ params }: Props) {
    const { section, slug } = await params;
    const page = getPage(section, slug);
    if (!page) notFound();

    const t = await getTranslations("learn");

    return (
        <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
            <Link
                href={`/learn/${section}`}
                className="inline-flex items-center gap-1 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
                <ChevronLeft className="h-4 w-4" />
                {t(`sections.${section}.title`)}
            </Link>

            <article className="learn-prose">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{page.body}</ReactMarkdown>
            </article>
        </div>
    );
}
