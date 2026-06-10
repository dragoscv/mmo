/**
 * Server-side helpers that wrap <NotSignedIn>/<NoCompanion> with their
 * translated copy. Pages call these instead of constructing the props
 * by hand, keeping the auth-gate one-liner and avoiding 6 copies of
 * the same `getTranslations` boilerplate.
 */
import { getTranslations } from "next-intl/server";
import { NotSignedIn, NoCompanion } from "@/components/library-empty-state";

export type EmptyFeatureKey =
    | "dashboard"
    | "library"
    | "playlists"
    | "scanner"
    | "plugins"
    | "analysis";

export async function notSignedInFor(featureKey: EmptyFeatureKey) {
    const t = await getTranslations("empty");
    const feature = t(`features.${featureKey}`);
    return (
        <NotSignedIn
            feature={feature}
            title={t("notSignedIn.title", { feature })}
            description={t("notSignedIn.description", { feature })}
            ctaLabel={t("notSignedIn.cta")}
        />
    );
}

export async function noCompanionFor(featureKey: EmptyFeatureKey) {
    const t = await getTranslations("empty");
    const feature = t(`features.${featureKey}`);
    return (
        <NoCompanion
            feature={feature}
            title={t("noCompanion.title", { feature })}
            description={t("noCompanion.description", { feature })}
            ctaLabel={t("noCompanion.cta")}
        />
    );
}
