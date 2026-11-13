import "@/components/suite/suite.css";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AudioWaveform, Download, Layers, Library } from "lucide-react";
import { BrandMark, Button } from "@mmo/ui";
import Link from "@/components/host/host-context";
import { SuiteFooter, SuiteTopBar } from "@/components/suite/suite-landing";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("mx.suite.dj");
    return { title: { absolute: t("title") }, description: t("subtitle") };
}

/** `decks.mixai.ro` (WP17-51, renamed D60 / ADR-0014) — MixAI Decks landing + downloads. Public, server-rendered.
 *  The old `dj.mixai.ro` host 308s here (`routeRequest`). Route stays `/dj` (internal mount). */
export default async function DjLanding() {
    const t = await getTranslations("mx.suite.dj");
    const ts = await getTranslations("mx.suite");
    const features = [
        { key: "engine", icon: AudioWaveform },
        { key: "stems", icon: Layers },
        { key: "library", icon: Library },
    ] as const;
    return (
        <div className="sx" style={{ ["--c" as string]: "var(--product-decks)" }}>
            <SuiteTopBar />
            <main className="sx-wrap">
                <section className="sx-hero" aria-labelledby="dj-title">
                    <div>
                        {/* The product page carries its own mark (brand/BRAND.md). It starts first, with its own
                            intro and nothing over it; the text rises while the intro finishes. -ml: the platter
                            sits 11 px inside its box, so the box moves left to line the ring up with the text edge. */}
                        <BrandMark product="decks" size={72} animation="intro" decorative className="-ml-2.5" />
                        <p className="sx-eyebrow sx-rise mt-4" style={{ ["--i" as string]: 3 }}>{ts("products.dj.tagline")}</p>
                        <h1 id="dj-title" className="sx-title sx-rise" style={{ ["--i" as string]: 4 }}>{t("title")}</h1>
                        <p className="sx-sub sx-rise" style={{ ["--i" as string]: 5 }}>{t("subtitle")}</p>
                        <div className="sx-cta sx-rise" style={{ ["--i" as string]: 6 }}>
                            <Button size="lg" render={<Link href="/get#native" />}><Download aria-hidden /> {t("cta")}</Button>
                        </div>
                    </div>
                    <ul className="sx-products !mt-0 !grid-cols-1">
                        {features.map((f, i) => (
                            <li key={f.key} className="sx-card sx-rise" style={{ ["--i" as string]: i + 5 }}>
                                <span className="sx-card-icon"><f.icon aria-hidden /></span>
                                <h3>{t(`features.${f.key}.title`)}</h3>
                                <p>{t(`features.${f.key}.body`)}</p>
                            </li>
                        ))}
                    </ul>
                </section>
            </main>
            <SuiteFooter />
        </div>
    );
}
