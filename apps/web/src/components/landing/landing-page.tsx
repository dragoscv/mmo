/**
 * Server-rendered landing for unauthenticated visitors at `/`.
 * Resolves copy with next-intl, then hands the (small) animated hero to the
 * client `HeroStage`. Everything else stays server-first.
 */
import Link from "next/link";
import { Download, Radio, Sparkles, Waves } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { SignInButton } from "@/components/sign-in-button";
import { HeroStage } from "./hero-stage";

export async function LandingPage() {
    const t = await getTranslations("landing");
    return (
        <HeroStage
            eyebrow={t("eyebrow")}
            title={t("title")}
            subtitle={t("subtitle")}
            primary={<SignInButton size="lg" className="shadow-glow" label={t("ctaPrimary")} />}
            secondary={
                <Button asChild size="lg" variant="outline">
                    <Link href="/get">
                        <Download aria-hidden /> {t("ctaSecondary")}
                    </Link>
                </Button>
            }
            features={[
                { icon: <Waves aria-hidden />, title: t("features.library.title"), description: t("features.library.description") },
                { icon: <Sparkles aria-hidden />, title: t("features.ai.title"), description: t("features.ai.description") },
                { icon: <Radio aria-hidden />, title: t("features.everywhere.title"), description: t("features.everywhere.description") },
            ]}
        />
    );
}
