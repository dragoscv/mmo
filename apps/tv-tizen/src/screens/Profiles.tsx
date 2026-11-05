/**
 * "Who's watching?" (WP16-31). Avatar grid → select; PIN profiles open the PinPad (remote digits + keypad,
 * shake on a wrong PIN, `triesLeft`), a 429 lock shows a live countdown on the tile and in the pad. Kids profiles
 * carry a badge. "Manage profiles" → Settings (section `profiles`). Selecting calls `ctx.app.profileChanged()`,
 * which remounts the stack at Home for the new profile.
 */
import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n/messages";
import { fmtClock } from "../lib/format";
import type { Profile } from "../lib/media-types";
import type { ScreenProps } from "../nav/ctx";
import { ProfileAvatar } from "../nav/Rail";
import { Empty, ErrorState, Icon, LoadingBlock, PinPad, SecondaryButton } from "../ui";

type Load = { s: "loading" } | { s: "ok"; list: Profile[] } | { s: "error"; message: string };

/** Lock expiry per profile id (epoch ms), shared across mounts of this screen. */
const lockedUntil = new Map<string, number>();

function useNow(active: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return;
        const h = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(h);
    }, [active]);
    return now;
}

export function Profiles({ ctx, params }: ScreenProps<"profiles">) {
    const [load, setLoad] = useState<Load>({ s: "loading" });
    const [pinFor, setPinFor] = useState<Profile | null>(null);
    const [pinError, setPinError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [resetKey, setResetKey] = useState(0);
    const anyLocked = load.s === "ok" && load.list.some((p) => (lockedUntil.get(p.id) ?? 0) > Date.now());
    const now = useNow(anyLocked || pinFor !== null);

    const fetchList = useCallback(() => {
        setLoad({ s: "loading" });
        ctx.profiles.refresh()
            .then((list) => setLoad({ s: "ok", list }))
            .catch((e: Error) => setLoad({ s: "error", message: t("profiles.loadError", { message: e.message }) }));
    }, [ctx.profiles]);

    useEffect(() => { fetchList(); }, [fetchList]);

    const activate = useCallback(() => {
        ctx.app.profileChanged();
    }, [ctx.app]);

    const choose = (p: Profile) => {
        const until = lockedUntil.get(p.id) ?? 0;
        if (p.hasPin) {
            // A still-valid token for this profile skips the pad.
            if (ctx.profiles.active?.id === p.id && ctx.profiles.token) { activate(); return; }
            setPinError(until > Date.now() ? t("profiles.tooMany", { time: fmtClock((until - Date.now()) / 1000) }) : null);
            setPinFor(p);
            return;
        }
        ctx.profiles.select(p);
        activate();
    };

    const submitPin = async (pin: string) => {
        const p = pinFor;
        if (!p) return;
        const until = lockedUntil.get(p.id) ?? 0;
        if (until > Date.now()) { setResetKey((k) => k + 1); return; }
        setBusy(true);
        const r = await ctx.profiles.unlock(p, pin);
        setBusy(false);
        if (r.ok) { setPinFor(null); activate(); return; }
        if (r.reason === "wrong") setPinError(r.triesLeft != null ? t("profiles.wrongPin", { n: r.triesLeft }) : t("profiles.wrongPinPlain"));
        else if (r.reason === "locked") {
            lockedUntil.set(p.id, Date.now() + r.retryAfterMs);
            setPinError(t("profiles.tooMany", { time: fmtClock(r.retryAfterMs / 1000) }));
        } else setPinError(t("profiles.unlockError", { message: r.message }));
        setResetKey((k) => k + 1);
    };

    // Live countdown in the pad while locked.
    const padUntil = pinFor ? lockedUntil.get(pinFor.id) ?? 0 : 0;
    const padError = padUntil > now ? t("profiles.tooMany", { time: fmtClock((padUntil - now) / 1000) }) : pinError;

    return (
        <div className="profiles" data-testid="profiles">
            <h1 className="profiles-title">{t("profiles.title")}</h1>
            {load.s === "loading" && <div style={{ width: "30rem" }}><LoadingBlock lines={2} /></div>}
            {load.s === "error" && <ErrorState message={load.message} onRetry={fetchList} />}
            {load.s === "ok" && load.list.length === 0 && <Empty icon="user" />}
            {load.s === "ok" && load.list.length > 0 && (
                <div className="profiles-grid" data-focus-row="profiles" data-focus-wrap="">
                    {load.list.map((p) => {
                        const until = lockedUntil.get(p.id) ?? 0;
                        const locked = until > now;
                        return (
                            <button key={p.id} type="button" className="profile-tile" data-focusable="" data-focus-key={`profile:${p.id}`}
                                data-testid={`profile-${p.id}`} aria-label={p.name} onClick={() => choose(p)}
                                autoFocus={ctx.profiles.active?.id === p.id}>
                                <ProfileAvatar profile={p} size="6.5rem" />
                                <span className="profile-name">{p.name}</span>
                                <span className="profile-tags">
                                    {p.kind === "kid" && <span className="badge badge-warning"><Icon name="kids" />{t("profiles.kids")}</span>}
                                    {p.hasPin && <span className="badge badge-neutral" aria-label={t("profiles.pin")}><Icon name="lock" /></span>}
                                </span>
                                {locked && <span className="profile-locked">{t("profiles.lockedFor", { time: fmtClock((until - now) / 1000) })}</span>}
                            </button>
                        );
                    })}
                </div>
            )}
            <div className="profiles-actions" data-focus-row="profiles-actions">
                <SecondaryButton icon="settings" label={t("profiles.manage")} focusKey="profiles:manage" testId="profiles-manage"
                    onClick={() => ctx.nav.push({ name: "settings", section: "profiles" })} />
                {params.manage && ctx.nav.canPop && (
                    <SecondaryButton icon="chevronLeft" label={t("common.back")} focusKey="profiles:back" onClick={() => ctx.nav.pop()} />
                )}
            </div>
            {pinFor && (
                <PinPad
                    title={t("profiles.enterPin", { name: pinFor.name })}
                    error={padError}
                    disabled={busy || padUntil > now}
                    resetKey={resetKey}
                    onComplete={(pin) => { void submitPin(pin); }}
                    onCancel={() => { setPinFor(null); setPinError(null); }}
                />
            )}
        </div>
    );
}
