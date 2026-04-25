"use client";

import Image from "next/image";
import { LoginForm } from "@/components/login-form";
import { useRenderCount } from "@/lib/dev-debugger";

export function LoginPageClient() {
    useRenderCount("Page:/login");
    return (
        <div className="flex min-h-full items-center justify-center px-4">
            <div className="w-full max-w-sm space-y-8">
                {/* Logo */}
                <div className="flex flex-col items-center gap-3">
                    <Image
                        src="/logo.svg"
                        alt="MMO"
                        width={56}
                        height={56}
                        className="rounded-2xl shadow-[0_0_24px_rgba(139,92,246,0.3)]"
                    />
                    <div className="text-center">
                        <h1 className="text-2xl font-bold tracking-tight">
                            Welcome to MMO
                        </h1>
                        <p className="mt-1 text-sm text-muted-foreground">
                            Mwrty Music Organizer
                        </p>
                    </div>
                </div>

                {/* Login Card */}
                <div className="rounded-xl border border-border bg-card p-6 shadow-lg">
                    <LoginForm callbackUrl="/" />
                </div>

                {/* Skip option */}
                <p className="text-center text-xs text-muted-foreground/50">
                    You can also use the app without signing in.
                    <br />
                    Settings will be stored locally in your browser.
                </p>
            </div>
        </div>
    );
}
