"use client";

/**
 * "Who's watching" gate (WP16-36, D26). Profiles live on MMO Server; a PIN unlock returns a 12 h
 * token kept in localStorage (`mixai-web:profile`). Kids profiles are filtered server-side by age.
 * Keyboard: arrows move between tiles, Enter picks; the PIN pad accepts typed digits + Backspace.
 */
import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Lock } from "lucide-react";
import { Button, Skeleton } from "@mmo/ui";
import type { Profile } from "@/lib/mmo/media-types";
import { useMmo } from "./mmo-provider";
import { ProfileAvatar } from "./profile-avatar";

export function ProfileGate({ children }: { children: ReactNode }) {
    const { profilesReady, needsPicker } = useMmo();
    if (!profilesReady) return <GateLoading />;
    if (needsPicker) return <WhoIsWatching />;
    return <>{children}</>;
}

function GateLoading() {
    const t = useTranslations("mx.profiles.gate");
    return (
        <div className="mx-gate" aria-busy>
            <p className="sr-only">{t("loading")}</p>
            <div className="mx-gate-grid">
                {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="mx-gate-skel" />)}
            </div>
        </div>
    );
}

function WhoIsWatching() {
    const t = useTranslations("mx.profiles.gate");
    const { clients, profileChanged } = useMmo();
    const [pinFor, setPinFor] = useState<Profile | null>(null);
    const list = clients?.profiles.profiles ?? [];
    const gridRef = useRef<HTMLUListElement>(null);

    useEffect(() => { gridRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, []);

    const pick = async (p: Profile) => {
        if (!clients) return;
        if (p.hasPin && !(clients.profiles.profileId === p.id && clients.profiles.token)) { setPinFor(p); return; }
        if (p.hasPin) clients.profiles.select(p);
        else {
            const r = await clients.profiles.unlock(p);
            if (!r.ok) clients.profiles.select(p);
        }
        profileChanged();
    };

    const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
        const btns = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        if (i < 0) return;
        const n = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : -2;
        if (n === -2) return;
        e.preventDefault();
        btns[(n + btns.length) % btns.length]?.focus();
    };

    if (pinFor) return <PinPad profile={pinFor} onCancel={() => setPinFor(null)} onDone={() => { setPinFor(null); profileChanged(); }} />;

    return (
        <section className="mx-gate" aria-labelledby="mx-gate-title">
            <h1 id="mx-gate-title" className="mx-gate-title">{t("title")}</h1>
            <ul ref={gridRef} className="mx-gate-grid" onKeyDown={onKey}>
                {list.map((p) => (
                    <li key={p.id}>
                        <button type="button" className="mx-gate-tile" onClick={() => void pick(p)} data-testid={`profile-${p.id}`}>
                            <ProfileAvatar profile={p} size={112} />
                            <span className="mx-gate-name">{p.name}</span>
                            <span className="mx-gate-meta">
                                {p.kind === "kid" ? t("kid") : null}
                                {p.hasPin ? <><Lock aria-hidden className="size-3.5" /><span className="sr-only">{t("locked")}</span></> : null}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
            <Button variant="outline" render={<Link href="/profiles" />}>{t("manage")}</Button>
        </section>
    );
}

const PIN_LEN = 4;

function PinPad({ profile, onCancel, onDone }: { profile: Profile; onCancel: () => void; onDone: () => void }) {
    const t = useTranslations("mx.profiles.pin");
    const { clients } = useMmo();
    const [pin, setPin] = useState("");
    const [msg, setMsg] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => { rootRef.current?.focus(); }, []);

    const submit = async (value: string) => {
        if (!clients) return;
        setBusy(true);
        const r = await clients.profiles.unlock(profile, value);
        setBusy(false);
        if (r.ok) { onDone(); return; }
        setPin("");
        if (r.reason === "wrong") setMsg(t("wrong", { tries: r.triesLeft ?? 0 }));
        else if (r.reason === "locked") setMsg(t("locked", { minutes: Math.max(1, Math.ceil(r.retryAfterMs / 60_000)) }));
        else setMsg(t("error", { message: r.message }));
    };

    const press = (d: string) => {
        if (busy || pin.length >= PIN_LEN) return;
        const next = pin + d;
        setPin(next);
        setMsg(null);
        if (next.length === PIN_LEN) void submit(next);
    };

    const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
        if (/^\d$/.test(e.key)) { e.preventDefault(); press(e.key); }
        else if (e.key === "Backspace") { e.preventDefault(); setPin((p) => p.slice(0, -1)); }
        else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };

    return (
        <div ref={rootRef} tabIndex={-1} className="mx-gate" onKeyDown={onKey} aria-labelledby="mx-pin-title">
            <ProfileAvatar profile={profile} size={96} />
            <h1 id="mx-pin-title" className="mx-gate-title">{t("title", { name: profile.name })}</h1>
            <p className="text-muted-foreground text-sm">{t("hint")}</p>
            <div className="mx-pin-dots" role="status" aria-live="polite">
                {Array.from({ length: PIN_LEN }, (_, i) => <span key={i} className="mx-pin-dot" data-filled={i < pin.length || undefined} />)}
                <span className="sr-only">{pin.length}/{PIN_LEN}</span>
            </div>
            {msg ? <p role="alert" className="mx-pin-msg">{msg}</p> : null}
            <div className="mx-pin-pad">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                    <button key={d} type="button" className="mx-pin-key" onClick={() => press(d)} disabled={busy} aria-label={t("digit", { n: d })}>{d}</button>
                ))}
                <button type="button" className="mx-pin-key" onClick={onCancel}>{t("back")}</button>
                <button type="button" className="mx-pin-key" onClick={() => press("0")} disabled={busy} aria-label={t("digit", { n: "0" })}>0</button>
                <button type="button" className="mx-pin-key" onClick={() => setPin((p) => p.slice(0, -1))} disabled={busy || !pin}>{t("clear")}</button>
            </div>
        </div>
    );
}
