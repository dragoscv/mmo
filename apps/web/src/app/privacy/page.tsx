import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { isAppLocale, type AppLocale } from "@/i18n/locales";

/**
 * PUBLIC privacy policy (Google Play / App Store privacy policy URL). RO/EN; `?lang=en|ro` overrides
 * the `mmo-locale` cookie so store reviewers can open a fixed language. Facts must match the Play
 * Data safety form and the App Store privacy labels (docs/store/review-notes.md).
 */

export const dynamic = "force-dynamic";

const CONTACT_EMAIL = "support@mixai.ro";
const SECTIONS = ["server", "decks", "account", "sync", "push", "diagnostics", "noAds", "security", "rights", "children"] as const;

type Props = { searchParams: Promise<{ lang?: string }> };

async function pickLocale(searchParams: Props["searchParams"]): Promise<AppLocale> {
    const lang = (await searchParams).lang;
    if (lang && isAppLocale(lang)) return lang;
    const current = await getLocale();
    return isAppLocale(current) ? current : "ro";
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
    const locale = await pickLocale(searchParams);
    const t = await getTranslations({ locale, namespace: "mx.privacy" });
    return { title: t("metaTitle"), description: t("metaDescription"), robots: { index: true, follow: true } };
}

export default async function PrivacyPage({ searchParams }: Props) {
    const locale = await pickLocale(searchParams);
    const t = await getTranslations({ locale, namespace: "mx.privacy" });
    const other: AppLocale = locale === "ro" ? "en" : "ro";

    return (
        <main lang={locale} className="mx-auto w-full max-w-2xl space-y-6 px-4 py-8 sm:py-12">
            <header className="space-y-2">
                <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">{t("title")}</h1>
                <p className="text-xs text-muted-foreground">{t("updated")}</p>
                <p className="text-sm text-muted-foreground">{t("intro")}</p>
                <p className="text-sm">
                    <Link href={`/privacy?lang=${other}`} hrefLang={other} className="underline underline-offset-4">
                        {t("langSwitch")}
                    </Link>
                </p>
            </header>

            {SECTIONS.map((key) => (
                <section key={key} aria-labelledby={`privacy-${key}`} className="space-y-2 rounded-xl border border-border bg-card p-5">
                    <h2 id={`privacy-${key}`} className="text-base font-semibold">{t(`sections.${key}.title`)}</h2>
                    <p className="text-sm text-muted-foreground">
                        {key === "rights" ? t("sections.rights.body", { deleteUrl: "/account/delete" }) : t(`sections.${key}.body`)}
                    </p>
                    {key === "rights" ? (
                        <p className="text-sm">
                            <Link href="/account/delete" className="underline underline-offset-4">/account/delete</Link>
                        </p>
                    ) : null}
                </section>
            ))}

            <p className="text-sm text-muted-foreground">
                {t("controller")}{" "}
                <a href={`mailto:${CONTACT_EMAIL}`} className="underline underline-offset-4">{CONTACT_EMAIL}</a>
            </p>
        </main>
    );
}
