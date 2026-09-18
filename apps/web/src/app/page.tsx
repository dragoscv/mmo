import "./media/media-home.css";
import { Suspense } from "react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Clapperboard } from "lucide-react";
import { Button, EmptyState, Page, PageHeader, Skeleton } from "@mmo/ui";
import { auth } from "@/auth";
import { LandingPage } from "@/components/landing/landing-page";
import { getMediaHome } from "@/actions/media";
import { CuratorNote } from "@/components/media/curator-note";
import { HeroBillboard } from "@/components/media/hero-billboard";
import { ListenRows } from "@/components/media/listen-rows";
import { ServerChips } from "@/components/media/server-chips";
import { ServerNotices } from "@/components/media/server-notices";
import { WatchRows } from "@/components/media/watch-rows";
import { noCompanionFor } from "@/components/empty-state-server";
import { buildServerChips, pickHeroCandidates } from "@/lib/media/home";

export const dynamic = "force-dynamic";

/**
 * `/` — Media Home (WP11-03). Watch rows come from every paired MMO Server
 * (`getMediaHome` fan-out + merge), Listen rows from `ListenRows`
 * (WP11-05). Rows span the full width; the hero clamps at 1600 px on
 * ultrawide screens (`.media-hero` max-width). Old dashboard: `/dashboard`.
 */
export default async function MediaHome() {
    const session = await auth();
    if (!session?.user?.id) return <LandingPage />;
    const t = await getTranslations("home");
    return (
        <Page width="full" className="media-home">
            <PageHeader title={t("title")} description={t("subtitle")} />
            <Suspense fallback={<WatchFallback />}>
                <WatchHalf />
            </Suspense>
            <ListenRows />
        </Page>
    );
}

function WatchFallback() {
    return (
        <div aria-busy>
            <Skeleton className="media-hero mb-8 h-[46vh] w-full" />
            <Skeleton className="mb-3 h-5 w-40" />
            <div className="flex gap-3 overflow-hidden">
                {Array.from({ length: 8 }, (_, j) => <Skeleton key={j} className="aspect-[2/3] w-36 shrink-0 rounded-xl" />)}
            </div>
        </div>
    );
}

async function WatchHalf() {
    const t = await getTranslations("home");
    const home = await getMediaHome().catch(() => null);
    if (!home || home.servers.length === 0) return noCompanionFor("home");

    const chips = buildServerChips(home.servers, home.rows);
    const hero = pickHeroCandidates(home.rows, 5);

    if (home.rows.length === 0) {
        return (
            <>
                <ServerNotices errors={home.errors} />
                <EmptyState
                    icon={<Clapperboard />}
                    title={t("empty.title")}
                    description={t("empty.description")}
                    actions={
                        <>
                            <Button render={<Link href="/settings/video" />}>{t("empty.ctaSettings")}</Button>
                            <Button variant="outline" render={<Link href="/library" />}>{t("empty.ctaLibrary")}</Button>
                        </>
                    }
                />
            </>
        );
    }

    return (
        <>
            {hero.length > 0 ? <HeroBillboard items={hero} /> : null}
            <CuratorNote notes={home.curatorNotes} />
            <ServerChips chips={chips} now={home.now} />
            <ServerNotices errors={home.errors} />
            <WatchRows rows={home.rows} />
        </>
    );
}
