"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import QRCode from "qrcode";
import { Loader2, Server, Sparkles, UserRound } from "lucide-react";
import { BrandMark, Button, Card, Field, FieldDescription, FieldError, FieldLabel, Input } from "@mmo/ui";
import Link, { useRouter } from "@/components/host/host-context";
import { displayDeviceName } from "@/lib/mmo/hub";
import {
    DEMO_SERVER_URL, hostLabel, needsDesktopProxy, normalizeServerUrl, readGuestState, withServer, writeGuestState,
} from "@/lib/mmo/guest-server";
import { PairError, POLL_INTERVAL_MS, fetchPairInfo, formatPairCode, pollPair, requestPair, type PairRequest } from "@/lib/mmo/pair-guest";
import { desktopLanServers, desktopServerUrl, hasDesktopLan, type LanServer } from "@/lib/mmo/desktop-lan";

type Phase =
    | { kind: "idle" }
    | { kind: "checking"; server: string }
    | { kind: "code"; server: string; name: string; req: PairRequest; qr: string }
    | { kind: "expired"; server: string }
    | { kind: "done"; name: string };

export function ConnectClient({ home, loginHref, initialServer, autoDemo }: { home: string; loginHref: string | null; initialServer: string; autoDemo: boolean }) {
    const t = useTranslations("mx.connect");
    const router = useRouter();
    const [address, setAddress] = useState(initialServer);
    const [phase, setPhase] = useState<Phase>({ kind: "idle" });
    const [error, setError] = useState<string | null>(null);
    const [now, setNow] = useState(0);
    const [lan, setLan] = useState<LanServer[] | null>(null);
    const run = useRef(0);

    // Desktop shells: servers announced on the local network (mDNS), like the phone apps (WP17-100).
    useEffect(() => {
        if (!hasDesktopLan()) return;
        let alive = true;
        void desktopLanServers().then((s) => { if (alive) setLan(s); });
        return () => { alive = false; };
    }, []);

    const fail = useCallback((server: string, e: unknown) => {
        const label = hostLabel(server);
        if (e instanceof PairError) {
            if (e.kind === "unreachable") setError(t("errUnreachable", { server: label }));
            else if (e.kind === "not-mmo") setError(t("errNotMmo", { server: label }));
            else if (e.kind === "no-token") setError(t("errNoToken", { server: label }));
            else setError(t("errHttp", { server: label, detail: e.message }));
        } else setError(t("errUnreachable", { server: label }));
        setPhase({ kind: "idle" });
    }, [t]);

    const start = useCallback(async (input: string) => {
        setError(null);
        const typed = normalizeServerUrl(input);
        if (!typed) { setError(t("errInvalid")); return; }
        // Inside the desktop shells an http LAN server goes through the shell's local proxy (WP17-97).
        let server = typed;
        if (needsDesktopProxy(typed, location.protocol)) {
            const proxied = await desktopServerUrl(typed);
            if (!proxied) { setError(t("errMixed", { server: hostLabel(typed) })); return; }
            server = proxied;
        }
        const id = ++run.current;
        setPhase({ kind: "checking", server });
        try {
            const info = await fetchPairInfo(server);
            if (!info.hasToken) throw new PairError("no-token", "no token");
            const req = await requestPair(server, displayDeviceName());
            const qr = req.approveUrl ? await QRCode.toDataURL(req.approveUrl, { margin: 1, width: 220 }) : "";
            if (id !== run.current) return;
            setPhase({ kind: "code", server, name: info.name || hostLabel(typed), req, qr });
        } catch (e) {
            if (id === run.current) fail(server, e);
        }
    }, [fail, t]);

    // Poll while a code is shown; save + go home once approved.
    useEffect(() => {
        if (phase.kind !== "code") return;
        const { server, name, req } = phase;
        const id = run.current;
        let stop = false;
        const tick = async () => {
            if (stop || id !== run.current) return;
            setNow(Date.now());
            if (Date.now() > req.expiresAt) { setPhase({ kind: "expired", server }); return; }
            try {
                const r = await pollPair(server, req.code, req.secret);
                if (stop || id !== run.current) return;
                if (r.status === "approved") {
                    writeGuestState(withServer(readGuestState(), { baseUrl: server, token: r.deviceToken, userId: r.userId ?? "", name, pairedAt: Date.now() }));
                    setPhase({ kind: "done", name });
                    router.replace(home);
                    return;
                }
                if (r.status === "expired") { setPhase({ kind: "expired", server }); return; }
            } catch { /* transient: keep polling */ }
            timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
        };
        let timer = setTimeout(() => void tick(), 600);
        return () => { stop = true; clearTimeout(timer); };
    }, [phase, home, router]);

    const demoStarted = useRef(false);
    useEffect(() => {
        if (autoDemo && !demoStarted.current) { demoStarted.current = true; void start(DEMO_SERVER_URL); }
    }, [autoDemo, start]);

    const cancel = () => { run.current++; setPhase({ kind: "idle" }); };
    const onSubmit = (e: FormEvent) => { e.preventDefault(); void start(address); };
    const busy = phase.kind === "checking";

    return (
        <main className="flex min-h-dvh items-center justify-center px-4 py-10">
            <Card className="w-full max-w-md space-y-6 p-6 sm:p-8">
                <header className="space-y-2 text-center">
                    <BrandMark product="server" size={36} decorative className="mx-auto" />
                    <h1 className="text-2xl font-semibold tracking-tight">{phase.kind === "code" ? t("codeTitle") : t("title")}</h1>
                    <p className="text-sm text-muted-foreground">{phase.kind === "code" ? t("codeBody") : t("subtitle")}</p>
                </header>

                {phase.kind === "code" ? (
                    <section aria-live="polite" className="space-y-5 text-center">
                        <div>
                            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("codeLabel")}</p>
                            <p className="font-mono text-4xl font-semibold tabular-nums tracking-widest" data-testid="pair-code">{formatPairCode(phase.req.code)}</p>
                        </div>
                        {phase.qr ? (
                            // eslint-disable-next-line @next/next/no-img-element -- data: URL generated client-side
                            <img src={phase.qr} alt={t("qrLabel")} width={180} height={180} className="mx-auto rounded-lg bg-white p-2" />
                        ) : null}
                        <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                            <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> {t("waiting")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {t("expires", { minutes: Math.max(1, Math.ceil((phase.req.expiresAt - (now || phase.req.expiresAt - 5 * 60_000)) / 60_000)) })}
                        </p>
                        <Button variant="ghost" onClick={cancel}>{t("cancel")}</Button>
                    </section>
                ) : phase.kind === "expired" ? (
                    <section className="space-y-4 text-center" aria-live="polite">
                        <p className="text-sm">{t("expired")}</p>
                        <div className="flex justify-center gap-2">
                            <Button onClick={() => void start(phase.server)}>{t("newCode")}</Button>
                            <Button variant="ghost" onClick={cancel}>{t("cancel")}</Button>
                        </div>
                    </section>
                ) : phase.kind === "done" ? (
                    <p className="text-center text-sm" aria-live="polite">{t("connected", { server: phase.name })}</p>
                ) : (
                    <>
                        <form onSubmit={onSubmit} className="space-y-3" noValidate>
                            <Field invalid={Boolean(error)}>
                                <FieldLabel>{t("addressLabel")}</FieldLabel>
                                <Input
                                    value={address}
                                    onChange={(e) => setAddress(e.target.value)}
                                    placeholder="https://"
                                    inputMode="url"
                                    autoComplete="url"
                                    autoCapitalize="none"
                                    spellCheck={false}
                                    disabled={busy}
                                    data-testid="connect-address"
                                />
                                <FieldDescription>{t("addressHint")}</FieldDescription>
                                {error ? <FieldError match role="alert">{error}</FieldError> : null}
                            </Field>
                            <Button type="submit" className="w-full" loading={busy} disabled={busy || !address.trim()} data-testid="connect-submit">
                                {busy ? t("checking") : t("connect")}
                            </Button>
                        </form>

                        <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden>
                            <span className="h-px flex-1 bg-border" />{t("or")}<span className="h-px flex-1 bg-border" />
                        </div>

                        {lan !== null ? (
                            <section className="space-y-2" aria-label={t("lanTitle")}>
                                <h2 className="text-sm font-medium">{t("lanTitle")}</h2>
                                {lan.length === 0 ? <p className="text-xs text-muted-foreground">{t("lanEmpty")}</p> : (
                                    <ul className="space-y-2">
                                        {lan.map((s) => (
                                            <li key={s.url}>
                                                <Button variant="outline" className="w-full justify-start" disabled={busy} onClick={() => { setAddress(s.url); void start(s.url); }}>
                                                    <Server aria-hidden className="size-4" /> {s.name} <span className="ml-auto text-xs text-muted-foreground">{hostLabel(s.url)}</span>
                                                </Button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>
                        ) : null}

                        <div className="space-y-3">
                            <Button variant="secondary" className="w-full" disabled={busy} onClick={() => { setAddress(DEMO_SERVER_URL); void start(DEMO_SERVER_URL); }} data-testid="connect-demo">
                                <Sparkles aria-hidden className="size-4" /> {t("demo")}
                            </Button>
                            <p className="text-center text-xs text-muted-foreground">{t("demoHint")}</p>
                            {loginHref ? (
                                <>
                                    <Button variant="outline" className="w-full" render={<a href={loginHref} />}>
                                        <UserRound aria-hidden className="size-4" /> {t("signIn")}
                                    </Button>
                                    <p className="text-center text-xs text-muted-foreground">{t("signInHint")}</p>
                                </>
                            ) : (
                                <Button variant="ghost" className="w-full" render={<Link href={home} />}>{t("back")}</Button>
                            )}
                        </div>
                    </>
                )}
            </Card>
        </main>
    );
}
