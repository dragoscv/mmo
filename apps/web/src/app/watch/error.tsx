"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button, ErrorState, Page } from "@mmo/ui";

export default function WatchError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    const t = useTranslations("watch.error");
    useEffect(() => {
        console.error("[/watch] render failed:", error);
    }, [error]);

    return (
        <Page width="md" className="text-[var(--watch-fg)]">
            <ErrorState
                title={t("title")}
                detail={
                    <>
                        {t("detail")}{" "}
                        <code className="font-mono text-xs">{error.digest ?? "n/a"}</code>
                    </>
                }
                actions={
                    <>
                        <Button onClick={() => reset()}>{t("retry")}</Button>
                        <Button variant="outline" render={<Link href="/watch" />}>
                            {t("backHome")}
                        </Button>
                    </>
                }
            />
        </Page>
    );
}
