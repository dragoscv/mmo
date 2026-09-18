"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tv, CheckCircle2, XCircle, Loader2, AlertTriangle } from "lucide-react";
import {
    approveDeviceCode,
    denyDeviceCode,
    lookupDeviceCode,
    type DeviceCodeActionError,
    type DeviceCodeInfo,
    type DeviceCodeLookup,
} from "@/actions/device-code";
import { formatUserCode, isValidUserCode, normalizeUserCode } from "@/lib/device-code";

interface ActivateClientProps {
    initialCode: string;
    initialLookup: DeviceCodeLookup | null;
}

type Done = { kind: "approved" | "denied"; deviceName: string };

export function ActivateClient({ initialCode, initialLookup }: ActivateClientProps) {
    const t = useTranslations("activate");
    const [code, setCode] = useState(initialCode);
    const [info, setInfo] = useState<DeviceCodeInfo | null>(initialLookup?.ok ? initialLookup.info : null);
    const [error, setError] = useState<DeviceCodeActionError | null>(
        initialLookup && !initialLookup.ok ? initialLookup.error : null,
    );
    const [done, setDone] = useState<Done | null>(null);
    const [pending, startTransition] = useTransition();

    const codeValid = isValidUserCode(code);
    const busy = pending;

    function onCodeChange(raw: string) {
        setError(null);
        setInfo(null);
        setCode(normalizeUserCode(raw).slice(0, 8));
    }

    function lookup() {
        if (!codeValid || busy) return;
        startTransition(async () => {
            const r = await lookupDeviceCode(code);
            if (r.ok) setInfo(r.info);
            else setError(r.error);
        });
    }

    function decide(kind: "approved" | "denied") {
        if (!codeValid || busy) return;
        startTransition(async () => {
            const r = kind === "approved" ? await approveDeviceCode(code) : await denyDeviceCode(code);
            if (r.ok) setDone({ kind, deviceName: r.deviceName });
            else setError(r.error);
        });
    }

    if (done) {
        const approved = done.kind === "approved";
        return (
            <main className="mx-auto flex min-h-[70dvh] w-full max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
                {approved
                    ? <CheckCircle2 className="h-20 w-20 text-emerald-500" aria-hidden />
                    : <XCircle className="h-20 w-20 text-muted-foreground" aria-hidden />}
                <h1 className="text-2xl font-bold">{approved ? t("successTitle") : t("deniedTitle")}</h1>
                <p className="text-muted-foreground">
                    {approved ? t("successBody", { device: done.deviceName }) : t("deniedBody", { device: done.deviceName })}
                </p>
            </main>
        );
    }

    return (
        <main className="mx-auto w-full max-w-md p-4 sm:p-6">
            <Card>
                <CardHeader className="items-center text-center">
                    <Tv className="mb-2 h-12 w-12 text-primary" aria-hidden />
                    <CardTitle className="text-xl">
                        {info ? t("title", { device: info.deviceName, platform: info.platform }) : t("titleNoDevice")}
                    </CardTitle>
                    <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-1.5">
                        <label htmlFor="activate-code" className="text-sm font-medium">{t("codeLabel")}</label>
                        <Input
                            id="activate-code"
                            value={code.length > 4 ? formatUserCode(code.padEnd(8, " ")).trimEnd() : code}
                            onChange={(e) => onCodeChange(e.target.value)}
                            inputMode="text"
                            autoCapitalize="characters"
                            autoCorrect="off"
                            spellCheck={false}
                            maxLength={9}
                            autoComplete="one-time-code"
                            placeholder="ABCD-2345"
                            aria-invalid={code.length > 0 && !codeValid}
                            disabled={busy}
                            className="h-16 text-center font-mono text-3xl uppercase tracking-[0.3em]"
                            onKeyDown={(e) => { if (e.key === "Enter" && !info) lookup(); }}
                        />
                    </div>
                    {error && (
                        <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                            <span>{t(`errors.${error}`)}</span>
                        </p>
                    )}
                    {info ? (
                        <div className="grid grid-cols-2 gap-3">
                            <Button
                                size="lg"
                                variant="outline"
                                className="h-14 text-lg"
                                onClick={() => decide("denied")}
                                disabled={busy}
                            >
                                {t("deny")}
                            </Button>
                            <Button size="lg" className="h-14 text-lg" onClick={() => decide("approved")} disabled={busy}>
                                {busy ? <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden /> : null}
                                {t("approve")}
                            </Button>
                        </div>
                    ) : (
                        <Button size="lg" className="h-14 w-full text-lg" onClick={lookup} disabled={!codeValid || busy}>
                            {busy ? <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden /> : null}
                            {t("continue")}
                        </Button>
                    )}
                </CardContent>
            </Card>
        </main>
    );
}
