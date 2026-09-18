"use client";

/**
 * Watch half of Media Home: applies the `?servers=` chip filter to the
 * merged rows (client-side, no refetch) and renders one `MediaRow` per
 * server row.
 */
import { useLocale, useTranslations } from "next-intl";
import { filterRowsByServers, rowTitle } from "@/lib/media/home";
import type { HomeRow } from "@/lib/media/types";
import { MediaCard } from "./media-card";
import { MediaRow } from "./media-row";
import { useSelectedServers } from "./server-chips";

export function WatchRows({ rows }: { rows: HomeRow[] }) {
    const locale = useLocale();
    const t = useTranslations("home");
    const [selected] = useSelectedServers();
    const visible = filterRowsByServers(rows, selected);
    if (visible.length === 0) {
        return <p className="text-sm text-muted-foreground">{t("servers.noneForSelection")}</p>;
    }
    return (
        <>
            {visible.map((row) => (
                <MediaRow
                    key={row.id}
                    id={`row-${row.id}`}
                    title={rowTitle(row, locale)}
                    reason={row.reason ? (locale.startsWith("ro") ? row.reason.ro : row.reason.en) : null}
                    seeAllHref={row.id === "continue" ? "/watch/continue" : undefined}
                >
                    {row.items.map((it) => (
                        <MediaCard key={`${it.kind}:${it.tmdbId}`} item={it} serverLabel={t("servers.countLabel")} />
                    ))}
                </MediaRow>
            ))}
        </>
    );
}
