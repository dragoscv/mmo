import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { DELETE_CONFIRMATION } from "@/lib/account/delete-account";
import { DeleteAccountForm } from "./delete-account-form";
import { SignedOutActions } from "./signed-out-actions";

/**
 * PUBLIC account-deletion page (App Store 5.1.1(v) + Google Play "delete account URL").
 * Signed in → explanation + typed confirmation → `deleteAccount` server action.
 * Signed out → how to delete (app, sign in here, or email request).
 */

export const dynamic = "force-dynamic";

const SUPPORT_EMAIL = "support@mixai.ro";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("mx.account.delete");
    return { title: t("metaTitle"), description: t("metaDescription"), robots: { index: true, follow: true } };
}

const WHAT = ["account", "devices", "media", "ai", "billing", "apple"] as const;

export default async function AccountDeletePage() {
    const t = await getTranslations("mx.account.delete");
    const session = await auth();
    const user = session?.user;
    const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(t("emailSubject"))}`;

    return (
        <main className="mx-auto w-full max-w-2xl space-y-6 px-4 py-8 sm:py-12">
            <header className="space-y-2">
                <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">{t("title")}</h1>
                <p className="text-sm text-muted-foreground">{t("intro")}</p>
            </header>

            <section aria-labelledby="del-what" className="space-y-3 rounded-xl border border-border bg-card p-5">
                <h2 id="del-what" className="text-base font-semibold">{t("whatTitle")}</h2>
                <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
                    {WHAT.map((k) => <li key={k}>{t(`what.${k}`)}</li>)}
                </ul>
                <h2 className="pt-2 text-base font-semibold">{t("keepTitle")}</h2>
                <p className="text-sm text-muted-foreground">{t("keep")}</p>
                <p className="text-xs text-muted-foreground">{t("timing")}</p>
            </section>

            {user ? (
                <section aria-labelledby="del-confirm" className="space-y-4 rounded-xl border border-destructive/40 bg-destructive/5 p-5">
                    <h2 id="del-confirm" className="text-base font-semibold" data-testid="delete-signed-in">
                        {user.email ? t("signedInAs", { email: user.email }) : t("signedInAsUnknown")}
                    </h2>
                    <DeleteAccountForm word={DELETE_CONFIRMATION} />
                    <p className="text-xs text-muted-foreground">
                        <Link href="/settings/account" className="underline underline-offset-4">{t("settingsLink")}</Link>
                    </p>
                </section>
            ) : (
                <section aria-labelledby="del-how" className="space-y-4 rounded-xl border border-border bg-card p-5" data-testid="delete-signed-out">
                    <h2 id="del-how" className="text-base font-semibold">{t("signedOutTitle")}</h2>
                    <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
                        <li>{t("signedOutSteps.app")}</li>
                        <li>{t("signedOutSteps.web")}</li>
                        <li>{t("signedOutSteps.email", { email: SUPPORT_EMAIL })}</li>
                    </ol>
                    <SignedOutActions mailto={mailto} />
                </section>
            )}
        </main>
    );
}
