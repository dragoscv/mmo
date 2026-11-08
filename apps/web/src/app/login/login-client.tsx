"use client";

import Image from "next/image";
import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@mmo/ui";
import { LoginForm } from "@/components/login-form";
import { useRenderCount } from "@/lib/dev-debugger";
import { isMusicDesktop, openDesktopSignIn } from "@/lib/mmo/desktop-bridge";

const noop = () => () => undefined;

/** `/connect` on the product host the user came from (guest servers live in that origin's localStorage). */
export function connectHrefFor(callbackUrl: string): string {
    try {
        const u = new URL(callbackUrl);
        if (u.protocol === "https:" && /(^|\.)mixai\.ro$/.test(u.hostname)) return `${u.origin}/connect`;
    } catch { /* relative callback → same origin */ }
    return "/connect";
}

/** Inside the MixAI Music desktop shell (Tauri): Google blocks OAuth in embedded webviews → system browser. */
function DesktopSignIn() {
    const t = useTranslations("login");
    const desktop = useSyncExternalStore(noop, isMusicDesktop, () => false);
    if (!desktop) return null;
    return (
        <div className="rounded-xl border border-primary/40 bg-primary/5 p-4 text-center" data-testid="desktop-signin">
            <p className="text-sm font-semibold">{t("desktopTitle")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("desktopBody")}</p>
            <Button className="mt-3 w-full" onClick={() => void openDesktopSignIn()}>{t("desktopCta")}</Button>
        </div>
    );
}

export function LoginPageClient({ callbackUrl = "/", appleEnabled }: { callbackUrl?: string; appleEnabled?: boolean }) {
    useRenderCount("Page:/login");
    const t = useTranslations("login");
    return (
        <div className="flex min-h-full items-center justify-center px-4">
            <div className="w-full max-w-sm space-y-8">
                {/* Logo */}
                <div className="flex flex-col items-center gap-3">
                    <Image
                        src="/logo.svg"
                        alt="MixAI"
                        width={56}
                        height={56}
                        className="rounded-2xl shadow-[0_0_24px_rgba(124,92,255,0.35)]"
                    />
                    <div className="text-center">
                        <h1 className="text-2xl font-bold tracking-tight">
                            {t("welcomeTitle")}
                        </h1>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {t("welcomeSubtitle")}
                        </p>
                    </div>
                </div>

                {/* Login Card */}
                <DesktopSignIn />
                <div className="rounded-xl border border-border bg-card p-6 shadow-lg">
                    <LoginForm callbackUrl={callbackUrl} appleEnabled={appleEnabled} />
                </div>

                {/* Skip option */}
                <p className="text-center text-xs text-muted-foreground">
                    {t("skipNoteLine1")}
                    <br />
                    <a href={connectHrefFor(callbackUrl)} className="font-medium text-primary underline-offset-4 hover:underline" data-testid="login-connect">{t("skipNoteLine2")}</a>
                </p>
            </div>
        </div>
    );
}
