"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tv, CheckCircle2, Loader2, AlertTriangle } from "lucide-react";
import { approvePairing, type PairActionError } from "@/actions/pair";

interface PairClientProps {
    initialHost: string;
    initialPort: string;
    initialCode: string;
}

export function PairClient({ initialHost, initialPort, initialCode }: PairClientProps) {
    const t = useTranslations("pair");
    const [host, setHost] = useState(initialHost);
    const [code, setCode] = useState(initialCode.replace(/\D/g, "").slice(0, 6));
    const [error, setError] = useState<PairActionError | null>(null);
    const [done, setDone] = useState<{ deviceName: string } | null>(null);
    const [pending, startTransition] = useTransition();

    const codeValid = /^\d{6}$/.test(code);
    const canSubmit = codeValid && host.trim().length > 0 && !pending;

    function submit() {
        if (!canSubmit) return;
        startTransition(async () => {
            const port = initialPort ? Number(initialPort) : undefined;
            const r = await approvePairing({ host: host.trim(), port: Number.isFinite(port) ? port : undefined, code });
            if (r.ok) setDone({ deviceName: r.deviceName });
            else setError(r.error);
        });
    }

    if (done) {
        return (
            <main className="mx-auto flex min-h-[70dvh] w-full max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
                <CheckCircle2 className="h-20 w-20 text-emerald-500" aria-hidden />
                <h1 className="text-2xl font-bold">{t("successTitle")}</h1>
                <p className="text-muted-foreground">{t("successBody", { server: done.deviceName })}</p>
            </main>
        );
    }

    return (
        <main className="mx-auto w-full max-w-md p-4 sm:p-6">
            <Card>
                <CardHeader className="items-center text-center">
                    <Tv className="mb-2 h-12 w-12 text-primary" aria-hidden />
                    <CardTitle className="text-xl">
                        {host ? t("title", { server: host }) : t("titleNoServer")}
                    </CardTitle>
                    <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
                </CardHeader>
                <CardContent className="space-y-4">
                    {!initialHost && (
                        <div className="space-y-1.5">
                            <label htmlFor="pair-host" className="text-sm font-medium">{t("hostLabel")}</label>
                            <Input
                                id="pair-host"
                                value={host}
                                onChange={(e) => { setError(null); setHost(e.target.value); }}
                                placeholder="192.168.1.20"
                                autoComplete="off"
                                inputMode="url"
                                className="h-12 text-base"
                            />
                        </div>
                    )}
                    <div className="space-y-1.5">
                        <label htmlFor="pair-code" className="text-sm font-medium">{t("codeLabel")}</label>
                        <Input
                            id="pair-code"
                            value={code}
                            onChange={(e) => { setError(null); setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); }}
                            inputMode="numeric"
                            pattern="[0-9]{6}"
                            maxLength={6}
                            autoComplete="one-time-code"
                            placeholder="000000"
                            aria-invalid={code.length > 0 && !codeValid}
                            className="h-16 text-center font-mono text-3xl tracking-[0.5em]"
                            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                        />
                    </div>
                    {error && (
                        <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                            <span>{t(`errors.${error}`)}</span>
                        </p>
                    )}
                    <Button size="lg" className="h-14 w-full text-lg" onClick={submit} disabled={!canSubmit}>
                        {pending ? <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden /> : null}
                        {t("approve")}
                    </Button>
                </CardContent>
            </Card>
        </main>
    );
}
