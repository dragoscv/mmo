import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Compass, Home } from "lucide-react";
import { Button, EmptyState } from "@mmo/ui";

export default async function NotFound() {
    const t = await getTranslations("common");
    return (
        <EmptyState
            icon={<Compass aria-hidden />}
            title={t("notFound")}
            description={t("notFoundDetail")}
            actions={
                <Button render={<Link href="/" />}>
                    <Home aria-hidden /> {t("goHome")}
                </Button>
            }
        />
    );
}
