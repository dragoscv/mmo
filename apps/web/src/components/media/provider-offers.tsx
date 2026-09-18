/**
 * "Where to watch" (WP11-04): one button per streaming offer. Deep link when
 * the server resolved one (MOTN), else the provider's web page / search
 * (see `offerHref`). Attribution footer is mandatory (TMDB + JustWatch /
 * Movie of the Night depending on `attribution`). Server component.
 */
import { ExternalLink } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Badge } from "@mmo/ui";
import { tmdbImg } from "@/lib/media/normalize";
import { offerHref } from "@/lib/media/title";
import type { Availability } from "@/lib/media/types";

export async function ProviderOffers({ availability }: { availability: Availability }) {
    const t = await getTranslations("media.offers");
    const { offers, attribution } = availability;
    return (
        <section className="media-title-section" aria-labelledby="media-offers-title">
            <h2 id="media-offers-title">{t("title")}</h2>
            {offers.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("none")}</p>
            ) : (
                <ul className="media-offers" role="list">
                    {offers.map((o) => {
                        const logo = tmdbImg(o.logo, "w92");
                        return (
                            <li key={`${o.providerId}:${o.type}`}>
                                <a
                                    className="media-offer"
                                    href={offerHref(o)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    data-deeplink={o.link ? "" : undefined}
                                >
                                    {logo ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={logo} alt="" className="media-offer-logo" width={36} height={36} loading="lazy" />
                                    ) : (
                                        <span className="media-offer-logo" aria-hidden />
                                    )}
                                    <span className="media-offer-name">{o.name}</span>
                                    <Badge variant="secondary">{t(`type.${o.type}`)}</Badge>
                                    <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                                </a>
                            </li>
                        );
                    })}
                </ul>
            )}
            <p className="media-attribution">
                <span>{t("tmdb")}</span>
                {attribution.some((a) => /justwatch/i.test(a)) || availability.source === "tmdb" ? <span>{t("justwatch")}</span> : null}
                {attribution.some((a) => /movie of the night|motn/i.test(a)) || availability.source === "motn" ? <span>{t("motn")}</span> : null}
            </p>
        </section>
    );
}
