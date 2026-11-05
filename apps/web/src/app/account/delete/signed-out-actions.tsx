"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { buttonVariants } from "@/components/ui/button";

/** Client island: `buttonVariants` lives in a "use client" module and can't be called from the server page. */
export function SignedOutActions({ mailto }: { mailto: string }) {
    const t = useTranslations("mx.account.delete");
    return (
        <div className="flex flex-wrap gap-3">
            <Link href={`/login?callbackUrl=${encodeURIComponent("/account/delete")}`} className={buttonVariants({ variant: "default" })}>
                {t("signInButton")}
            </Link>
            <a href={mailto} className={buttonVariants({ variant: "outline" })}>{t("emailButton")}</a>
        </div>
    );
}
