"use client";

import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { AppleLogo } from "@/components/auth/apple-logo";
import { GoogleLogo } from "@/components/auth/google-logo";

interface LoginFormProps {
    callbackUrl?: string;
    compact?: boolean;
    /** Server-side flag (`appleWebEnabled` from @/auth): shows "Sign in with Apple". */
    appleEnabled?: boolean;
}

export function LoginForm({ callbackUrl = "/", compact, appleEnabled }: LoginFormProps) {
    const [loading, setLoading] = useState<null | "google" | "apple">(null);
    const tLogin = useTranslations("login");
    const tAuth = useTranslations("auth");
    const tAccount = useTranslations("mx.account.signIn");

    async function handleSignIn(provider: "google" | "apple") {
        setLoading(provider);
        try {
            await signIn(provider, { callbackUrl });
        } catch {
            setLoading(null);
        }
    }

    return (
        <div className={compact ? "space-y-3" : "space-y-4"}>
            {!compact && (
                <div className="text-center space-y-1.5">
                    <h2 className="text-xl font-semibold">{tLogin("formTitle")}</h2>
                    <p className="text-sm text-muted-foreground">
                        {tLogin("formSubtitle")}
                    </p>
                </div>
            )}

            <Button
                variant="outline"
                size={compact ? "default" : "lg"}
                className="w-full gap-2.5"
                onClick={() => handleSignIn("google")}
                disabled={loading !== null}
            >
                {loading === "google" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                    <GoogleLogo className="h-4 w-4" />
                )}
                {tAuth("signInWithGoogle")}
            </Button>

            {appleEnabled && (
                // Apple HIG: black button, white logo + "Sign in with Apple" label.
                <Button
                    size={compact ? "default" : "lg"}
                    className="w-full gap-2.5 bg-black text-white hover:bg-black/85 dark:bg-white dark:text-black dark:hover:bg-white/90"
                    onClick={() => handleSignIn("apple")}
                    disabled={loading !== null}
                >
                    {loading === "apple" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <AppleLogo className="h-4 w-4" />
                    )}
                    {tAccount("apple")}
                </Button>
            )}

            {!compact && (
                <p className="text-center text-[11px] text-muted-foreground/60">
                    {tLogin("formFooter")}
                </p>
            )}
        </div>
    );
}
