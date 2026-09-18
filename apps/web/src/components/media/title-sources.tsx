/**
 * Local sources (WP11-04): one "Play on <server>" button per file, grouped by
 * MMO Server. Links to `/watch/play/<companionFileId>?server=<deviceId>&cid=…`
 * so the play page builds stream URLs for that device directly.
 */
import Link from "next/link";
import { Play } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@mmo/ui";
import { groupSourcesByServer } from "@/lib/media/title";
import type { TitleSource } from "@/lib/media/types";

export function playHref(s: TitleSource): string {
    const id = encodeURIComponent(String(s.fileId ?? ""));
    return `/watch/play/${id}?server=${encodeURIComponent(s.serverId)}&cid=${id}`;
}

function fileLabel(s: TitleSource): string | null {
    const parts: string[] = [];
    if (s.season != null && s.episode != null && (s.season > 0 || s.episode > 0)) {
        parts.push(`S${String(s.season).padStart(2, "0")}E${String(s.episode).padStart(2, "0")}`);
    }
    if (s.quality) parts.push(s.quality);
    return parts.length ? parts.join(" · ") : null;
}

export async function TitleSources({ sources, progress }: { sources: TitleSource[]; progress: number | null }) {
    const t = await getTranslations("media.sources");
    const groups = groupSourcesByServer(sources);
    return (
        <section className="media-title-section" id="sources" aria-labelledby="media-sources-title">
            <h2 id="media-sources-title">{t("title")}</h2>
            {groups.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("none")}</p>
            ) : (
                groups.map((g) => (
                    <div key={g.serverId} className="media-sources" data-server-id={g.serverId}>
                        {g.files.slice(0, 24).map((f, i) => {
                            const label = fileLabel(f);
                            return (
                                <Button key={`${f.fileId}-${i}`} size="lg" variant={i === 0 ? "default" : "secondary"} render={<Link href={playHref(f)} />}>
                                    <Play aria-hidden fill="currentColor" />
                                    {progress && progress > 0 && progress < 0.9 && i === 0 ? t("resumeOn", { server: g.serverName }) : t("playOn", { server: g.serverName })}
                                    {label ? <span className="text-xs opacity-75">{label}</span> : null}
                                </Button>
                            );
                        })}
                        {g.files.length > 24 ? <span className="text-xs text-muted-foreground">{t("moreFiles", { count: g.files.length - 24 })}</span> : null}
                    </div>
                ))
            )}
        </section>
    );
}
