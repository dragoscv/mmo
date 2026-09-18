import { Sparkles } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { CuratorNoteItem } from "@/lib/media/curator";
import { titleHref } from "./media-card";

/**
 * Codai curator notes (WP11-07): small, muted one-liners under the hero
 * explaining why the first picks fit tonight. Renders nothing when the
 * curator did not run (pref off, no key, timeout). Server component.
 */
export async function CuratorNote({ notes }: { notes: CuratorNoteItem[] }) {
    if (notes.length === 0) return null;
    const [t, locale] = await Promise.all([getTranslations("home.curator"), getLocale()]);
    const ro = locale.startsWith("ro");
    return (
        <aside className="media-curator" data-slot="curator-note" aria-label={t("label")}>
            <p className="media-curator-head">
                <Sparkles className="size-3.5 shrink-0" aria-hidden />
                <span>{t("by")}</span>
            </p>
            <ul className="media-curator-list" role="list">
                {notes.map((n) => (
                    <li key={`${n.kind}:${n.tmdbId}`}>
                        <Link href={titleHref({ kind: n.kind, tmdbId: n.tmdbId })} className="media-curator-title">{n.title}</Link>
                        <span className="media-curator-why"> — {ro ? n.why.ro : n.why.en}</span>
                    </li>
                ))}
            </ul>
        </aside>
    );
}
