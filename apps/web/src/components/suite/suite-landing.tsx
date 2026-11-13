/**
 * `mixai.ro` suite homepage (WP17-12, ADR-0013). Server-rendered; the orbit is pure CSS, the download matrix
 * hydrates to highlight the visitor's platform. Signed-in visitors get the launcher instead (`SuiteLauncher`).
 */
import "./suite.css";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { ArrowRight, Download, PlayCircle, ShieldCheck } from "lucide-react";
import { BrandLockup, BrandMark, Button } from "@mmo/ui";
import Link from "@/components/host/host-context";
import { SignInButton } from "@/components/sign-in-button";
import { SuiteOrbit } from "./orbit";
import { DownloadMatrix } from "./download-matrix";
import { SUITE_PRODUCTS } from "./products";

export async function SuiteLanding() {
    const t = await getTranslations("mx.suite");
    return (
        <div className="sx">
            {/* Page-level sky: two star depths (WP22-17). Decorative, fixed, behind everything (suite.css). */}
            <div className="sx-sky" aria-hidden />
            <SuiteTopBar end={<SignInButton label={t("hero.ctaStart")} />} />
            <main>
                <section className="sx-wrap sx-hero" aria-labelledby="sx-title">
                    {/* The copy waits for the core's mark intro and the planets (`--t0`); each line keeps its `--i`. */}
                    <div style={{ ["--t0" as string]: "620ms" }}>
                        <p className="sx-eyebrow sx-rise" style={{ ["--i" as string]: 0 }}>{t("hero.eyebrow")}</p>
                        <h1 id="sx-title" className="sx-title text-gradient-brand sx-rise" style={{ ["--i" as string]: 1 }}>
                            {/* One sentence per line on desktop ("Media ta." / "Pe orice ecran." / "De pe serverul tău."); breaks no longer fall mid-phrase. */}
                            {t("hero.title").split(/(?<=\.)\s+/).map((s, i) => <span key={i} className="sx-title-line">{s} </span>)}
                        </h1>
                        <p className="sx-sub sx-rise" style={{ ["--i" as string]: 2 }}>{t("hero.subtitle")}</p>
                        <div className="sx-cta sx-rise" style={{ ["--i" as string]: 3 }}>
                            <SignInButton size="lg" className="shadow-glow" label={t("hero.ctaStart")} />
                            <Button size="lg" variant="outline" render={<a href="#download" />}>
                                <Download aria-hidden /> {t("hero.ctaDownload")}
                            </Button>
                            <Button size="lg" variant="ghost" render={<a href="https://demo.mixai.ro" rel="noopener" />}>
                                <PlayCircle aria-hidden /> {t("hero.ctaDemo")}
                            </Button>
                        </div>
                    </div>
                    <SuiteOrbit label={t("hero.orbit")} />
                </section>

                <section id="products" className="sx-wrap sx-section" aria-labelledby="sx-products">
                    <h2 id="sx-products" className="sx-h2">{t("sections.productsTitle")}</h2>
                    <p className="sx-lead">{t("sections.productsBody")}</p>
                    <ul className="sx-products">
                        {SUITE_PRODUCTS.map((p, i) => {
                            return (
                                <li key={p.key} className="sx-card sx-rise" style={{ ["--c" as string]: p.accent, ["--i" as string]: i }}>
                                    <span className="sx-card-icon"><BrandMark product={p.brand} size={24} decorative /></span>
                                    <span className="sx-tag">{t(`products.${p.key}.tagline`)}</span>
                                    <h3 id={`sx-p-${p.key}`}>{t(`products.${p.key}.name`)}</h3>
                                    <p>{t(`products.${p.key}.body`)}</p>
                                    {/* The picture of the product (WP22-17): the MixAI TV home, captured on a TV. */}
                                    {i === 0 ? <img src="/brand/products/mixai-tv.webp" alt={t(`products.${p.key}.shotAlt`)} width={1920} height={1080} className="sx-card-art" /> : null}
                                    <Link id={`sx-more-${p.key}`} aria-labelledby={`sx-more-${p.key} sx-p-${p.key}`} href={p.key === "dj" ? "/dj" : p.key === "server" ? "/get" : p.internal} className="sx-card-link">
                                        {t("sections.learnMore")} <ArrowRight aria-hidden className="size-4" />
                                    </Link>
                                </li>
                            );
                        })}
                    </ul>
                </section>

                <section id="download" className="sx-wrap sx-section" aria-labelledby="sx-download">
                    <h2 id="sx-download" className="sx-h2">{t("sections.downloadTitle")}</h2>
                    <p className="sx-lead">{t("sections.downloadBody")}</p>
                    <DownloadMatrix />
                </section>

                <section className="sx-wrap sx-section" aria-labelledby="sx-privacy">
                    <div className="sx-privacy">
                        <span className="sx-privacy-icon"><ShieldCheck aria-hidden className="size-7" /></span>
                        <div>
                            <h2 id="sx-privacy" className="sx-h2 !text-2xl">{t("sections.privacyTitle")}</h2>
                            <p className="sx-lead !mt-2">{t("sections.privacyBody")}</p>
                        </div>
                        <Button variant="outline" render={<Link href="/privacy" />}>{t("footer.privacy")}</Button>
                    </div>
                </section>
            </main>
            <SuiteFooter />
        </div>
    );
}

export async function SuiteTopBar({ end }: { end?: ReactNode }) {
    const t = await getTranslations("mx.suite");
    return (
        <header className="sx-top">
            <div className="sx-wrap sx-top-in">
                <Link href="/" className="sx-brand mixai-logo-press">
                    {/* The family lockup as the brand book defines it: symbol + outlined lettering, one drawing. */}
                    <BrandLockup product="mark" height={28} />
                </Link>
                <nav className="sx-top-nav" aria-label={t("sections.productsTitle")}>
                    {SUITE_PRODUCTS.map((p) => (
                        <Link key={p.key} href={p.key === "server" ? "/get" : p.internal}>{t(`products.${p.key}.name`)}</Link>
                    ))}
                </nav>
                <div className="sx-top-end">{end}</div>
            </div>
        </header>
    );
}

export async function SuiteFooter() {
    const t = await getTranslations("mx.suite");
    return (
        <footer className="sx-foot">
            <div className="sx-wrap sx-foot-in">
                <span>{t("footer.rights", { year: new Date().getFullYear() })}</span>
                <Link href="/privacy">{t("footer.privacy")}</Link>
                <Link href="/status">{t("footer.status")}</Link>
                <a href="mailto:support@mixai.ro">{t("footer.support")}</a>
            </div>
        </footer>
    );
}
