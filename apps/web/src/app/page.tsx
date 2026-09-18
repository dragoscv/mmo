import { getTranslations } from "next-intl/server";
import { Page, PageHeader } from "@mmo/ui";
import { auth } from "@/auth";
import { LandingPage } from "@/components/landing/landing-page";
import { MediaHomePlaceholder } from "@/components/media/media-home-placeholder";

export const dynamic = "force-dynamic";

/**
 * `/` — Media Home (WP11-01). Watch + Listen rows land here in WP11-03;
 * until then this renders the header and a skeleton-shaped placeholder so
 * the route, nav, i18n and loading state are already in place. The old
 * music dashboard lives at `/dashboard`.
 */
export default async function MediaHome() {
    const session = await auth();
    if (!session?.user?.id) return <LandingPage />;
    const t = await getTranslations("home");
    return (
        <Page width="full">
            <PageHeader title={t("title")} description={t("subtitle")} />
            <MediaHomePlaceholder />
        </Page>
    );
}
