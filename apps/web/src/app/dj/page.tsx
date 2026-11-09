import "@/components/suite/suite.css";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AudioWaveform, Download, Layers, Library } from "lucide-react";
import { Button } from "@mmo/ui";
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
    const features = [
        { key: "engine", icon: AudioWaveform },
        { key: "stems", icon: Layers },
        { key: "library", icon: Library },
    ] as const;
    return (
        <div className="sx" style={{ ["--c" as string]: "var(--chart-4)" }}>
            <SuiteTopBar />
            <main className="sx-wrap">
                <section className="sx-hero" aria-labelledby="dj-title">
                    <div>
                        <h1 id="dj-title" className="sx-title text-gradient-brand sx-rise">{t("title")}</h1>
                        <p className="sx-sub sx-rise" style={{ ["--i" as string]: 1 }}>{t("subtitle")}</p>
                        <div className="sx-cta sx-rise" style={{ ["--i" as string]: 2 }}>
                            <Button size="lg" render={<Link href="/get#native" />}><Download aria-hidden /> {t("cta")}</Button>
                        </div>
                    </div>
                    <ul className="sx-products !mt-0">
                        {features.map((f, i) => (
                            <li key={f.key} className="sx-card sx-rise" style={{ ["--i" as string]: i + 2 }}>
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
