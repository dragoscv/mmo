/**
 * Settings › Profiles (WP16-33, port of tv-android ProfileEditor/SettingsSections): list, add, edit name /
 * colour / kind / max age, PIN set-change-remove (PinPad, twice to confirm), delete (Dialog). Editing a
 * PIN-protected profile needs its token: the PinPad unlocks it first (server 403 `profile_locked`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n/messages";
import { ApiError } from "../../lib/api";
import type { Profile, ProfileInput } from "../../lib/media-types";
import type { ScreenCtx } from "../../nav/ctx";
import { useBackHandler } from "../../nav/back";
import { ProfileAvatar } from "../../nav/Rail";
import {
    Dialog, ErrorState, Icon, Keyboard, LoadingBlock, PinPad, PrimaryButton, SecondaryButton, useFocusScope,
} from "../../ui";
import { mirrorPlayerPrefs } from "../player/usePlayerPrefs";
import { ChipRow, Group, Note, Row, Section } from "./parts";

/** Colour names both TVs understand (tv-android `profileColorOf` maps these onto its tokens). */
export const PROFILE_COLORS = ["violet", "magenta", "cyan", "blue", "emerald", "amber", "rose"] as const;
const LEGACY: Record<string, string> = { chart1: "violet", chart2: "magenta", chart3: "cyan", chart4: "violet", chart5: "blue", brand: "magenta", purple: "violet", pink: "magenta", teal: "cyan", green: "emerald", orange: "amber", yellow: "amber", red: "rose" };
export const MAX_AGES = [0, 7, 12, 14, 15, 18] as const;

export function colorClass(c: string | null | undefined): string {
    const n = (c ?? "").toLowerCase();
    const name = (PROFILE_COLORS as readonly string[]).includes(n) ? n : LEGACY[n] ?? "violet";
    return `pc-${name}`;
}

type PinStep = { kind: "unlock"; then: () => void } | { kind: "new" } | { kind: "confirm"; first: string };

export function ProfilesSection({ ctx }: { ctx: ScreenCtx }) {
    const [list, setList] = useState<Profile[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<Profile | "new" | null>(null);

    const load = useCallback(() => {
        setError(null);
        ctx.profiles.refresh().then(setList).catch((e: Error) => setError(e.message));
    }, [ctx.profiles]);
    useEffect(() => { load(); }, [load]);
    useEffect(() => ctx.profiles.changed.on(() => setList([...ctx.profiles.profiles])), [ctx.profiles]);

    if (error) return <Section title={t("set.profiles")}><ErrorState message={error} onRetry={load} /></Section>;
    if (!list) return <Section title={t("set.profiles")}><LoadingBlock lines={3} /></Section>;
    const active = ctx.profiles.active;

    return (
        <Section title={t("set.profiles")} sub={t("set.profilesSub")} testId="set-profiles">
            {list.length === 0 && <Note>{t("set.profilesNone")}</Note>}
            {list.map((p) => (
                <Row key={p.id} focusKey={`set:prof:${p.id}`} chevron onClick={() => setEditing(p)}
                    label={<span className="set-prof"><ProfileAvatar profile={p} size="1.8rem" /><span className={`set-swatch ${colorClass(p.color)}`} />{p.name}</span>}
                    sub={[
                        p.kind === "kid" ? t("set.kid") : t("set.adult"),
                        p.maxAge != null ? t("set.maxAgeValue", { n: p.maxAge }) : null,
                        p.hasPin ? t("set.pinOn") : null,
                        active?.id === p.id ? t("set.activeNow") : null,
                    ].filter(Boolean).join(" · ")} />
            ))}
            <div className="set-actions" data-focus-row="set-prof-actions">
                <PrimaryButton icon="plus" label={t("set.addProfile")} onClick={() => setEditing("new")} focusKey="set:prof:add" testId="set-add-profile" />
                <SecondaryButton icon="user" label={t("set.switchProfile")} onClick={() => ctx.nav.push({ name: "profiles", manage: true })} focusKey="set:prof:switch" />
            </div>
            {editing && (
                <ProfileEditor ctx={ctx} profile={editing === "new" ? null : editing}
                    onClose={(changed) => { setEditing(null); if (changed) load(); }} />
            )}
        </Section>
    );
}

function ProfileEditor({ ctx, profile, onClose }: { ctx: ScreenCtx; profile: Profile | null; onClose: (changed: boolean) => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const [name, setName] = useState(profile?.name ?? "");
    const [color, setColor] = useState<string>(profile?.color && (PROFILE_COLORS as readonly string[]).includes(profile.color) ? profile.color : colorClass(profile?.color).slice(3));
    const [kind, setKind] = useState<"adult" | "kid">(profile?.kind ?? "adult");
    const [maxAge, setMaxAge] = useState<number | null>(profile?.maxAge ?? null);
    const [pinChange, setPinChange] = useState<{ set: string } | "remove" | null>(null);
    const [pin, setPin] = useState<PinStep | null>(null);
    const [pinError, setPinError] = useState<string | null>(null);
    const [pinReset, setPinReset] = useState(0);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [kbOpen, setKbOpen] = useState(!profile);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useFocusScope(ref, !pin && !confirmDelete);
    useBackHandler(() => { onClose(false); }, !pin && !confirmDelete);

    const locked = !!profile?.hasPin && !(ctx.profiles.active?.id === profile.id && ctx.profiles.token);
    /** Runs `fn` after unlocking a PIN profile (token needed by PATCH/DELETE). */
    const withUnlock = (fn: () => void) => {
        if (!locked) { fn(); return; }
        setPinError(null);
        setPin({ kind: "unlock", then: fn });
    };

    const save = () => withUnlock(async () => {
        const n = name.trim();
        if (!n) { setError(t("set.nameRequired")); return; }
        setBusy(true);
        setError(null);
        try {
            const input: ProfileInput = { name: n, color, kind, maxAge: kind === "kid" ? (maxAge ?? 7) : maxAge };
            if (pinChange === "remove") input.pin = null;
            else if (pinChange) input.pin = pinChange.set;
            if (profile) await ctx.profiles.update(profile.id, input);
            else await ctx.profiles.create(input);
            if (profile && ctx.profiles.active?.id === profile.id) mirrorPlayerPrefs(ctx.profiles.active);
            onClose(true);
        } catch (e) {
            setError(e instanceof ApiError && e.status === 403 ? t("set.profileLocked") : t("set.saveFailed", { message: (e as Error).message }));
        } finally {
            setBusy(false);
        }
    });

    const remove = () => withUnlock(async () => {
        if (!profile) return;
        setBusy(true);
        try {
            const wasActive = ctx.profiles.active?.id === profile.id;
            await ctx.profiles.remove(profile.id);
            onClose(true);
            if (wasActive) ctx.nav.resetTo({ name: "profiles" });
        } catch (e) {
            setError(t("set.deleteFailed", { message: (e as Error).message }));
        } finally {
            setBusy(false);
            setConfirmDelete(false);
        }
    });

    const onPin = async (value: string) => {
        if (!pin) return;
        if (pin.kind === "unlock" && profile) {
            const r = await ctx.profiles.unlock(profile, value);
            if (r.ok) { const then = pin.then; setPin(null); then(); return; }
            setPinError(r.reason === "wrong" ? (r.triesLeft != null ? t("profiles.wrongPin", { n: r.triesLeft }) : t("profiles.wrongPinPlain"))
                : r.reason === "locked" ? t("set.pinLocked") : r.message);
            setPinReset((k) => k + 1);
            return;
        }
        if (pin.kind === "new") { setPin({ kind: "confirm", first: value }); setPinError(null); setPinReset((k) => k + 1); return; }
        if (pin.kind === "confirm") {
            if (value === pin.first) { setPinChange({ set: value }); setPin(null); return; }
            setPinError(t("set.pinMismatch"));
            setPin({ kind: "new" });
            setPinReset((k) => k + 1);
        }
    };

    const hasPinAfter = pinChange === "remove" ? false : pinChange ? true : !!profile?.hasPin;
    const preview: Profile = {
        id: profile?.id ?? "new", name: name || "?", avatar: profile?.avatar ?? null, color, kind, maxAge, hasPin: hasPinAfter,
        prefs: profile?.prefs ?? {}, sort: profile?.sort ?? 0, createdAt: 0, updatedAt: 0,
    };

    return (
        <div className="overlay" role="presentation">
            <div ref={ref} className="dialog set-editor" role="dialog" aria-modal="true" aria-labelledby="set-ed-title" data-focus-scope="" data-testid="profile-editor">
                <h2 id="set-ed-title" className="dialog-title">{profile ? t("set.editProfile") : t("set.addProfile")}</h2>
                <div className="set-editor-cols">
                    <div>
                        <div className="set-prof"><ProfileAvatar profile={preview} size="3rem" /><div className="set-name" aria-live="polite">{name || <span className="tg-dim">{t("set.namePlaceholder")}</span>}</div></div>
                        {kbOpen
                            ? <Keyboard value={name} onChange={setName} onDone={() => setKbOpen(false)} maxLength={24} id="set-name" />
                            : <Row focusKey="set:ed:name" icon="user" label={t("set.name")} value={name} onClick={() => setKbOpen(true)} chevron />}
                    </div>
                    <div>
                        <Group title={t("set.color")}>
                            <div className="set-swatches" data-focus-row="set-colors">
                                {PROFILE_COLORS.map((c) => (
                                    <button key={c} type="button" className={`set-swatch-btn pc-${c}${color === c ? " is-active" : ""}`} data-focusable=""
                                        data-focus-key={`set:color:${c}`} aria-label={t(`set.color.${c}`)} aria-pressed={color === c} onClick={() => setColor(c)} />
                                ))}
                            </div>
                        </Group>
                        <ChipRow label={t("set.kind")} rowId="set-kind" value={kind}
                            items={[{ id: "adult", label: t("set.adult") }, { id: "kid", label: t("set.kid"), icon: "kids" }]}
                            onChange={(id) => { setKind(id as "adult" | "kid"); if (id === "kid" && maxAge == null) setMaxAge(7); }} />
                        <ChipRow label={t("set.maxAge")} rowId="set-age" value={maxAge == null ? "none" : String(maxAge)}
                            items={[{ id: "none", label: t("set.noLimit") }, ...MAX_AGES.map((a) => ({ id: String(a), label: `${a}+` }))]}
                            onChange={(id) => setMaxAge(id === "none" ? null : Number(id))} />
                        <Group title={t("set.pin")}>
                            <Row focusKey="set:ed:pin" icon="lock" chevron
                                label={hasPinAfter ? t("set.pinChange") : t("set.pinSet")}
                                value={pinChange === "remove" ? t("set.pinWillRemove") : pinChange ? t("set.pinWillSet") : profile?.hasPin ? t("set.pinOn") : t("set.pinOff")}
                                onClick={() => { setPinError(null); setPin({ kind: "new" }); }} />
                            {hasPinAfter && <Row focusKey="set:ed:pinrm" label={t("set.pinRemove")} onClick={() => setPinChange("remove")} />}
                        </Group>
                    </div>
                </div>
                {error && <Note tone="error">{error}</Note>}
                <div className="dialog-actions" data-focus-row="set-ed-actions">
                    {profile && <SecondaryButton icon="close" label={t("set.delete")} onClick={() => setConfirmDelete(true)} focusKey="set:ed:delete" className="tbtn-destructive" disabled={busy} />}
                    <SecondaryButton label={t("common.cancel")} onClick={() => onClose(false)} focusKey="set:ed:cancel" />
                    <PrimaryButton icon="check" label={busy ? t("set.saving") : t("set.save")} onClick={() => { void save(); }} focusKey="set:ed:save" disabled={busy} testId="profile-save" />
                </div>
                {locked && <div className="set-note set-note-muted"><Icon name="lock" /> {t("set.needsPin")}</div>}
            </div>
            {pin && (
                <PinPad
                    title={pin.kind === "unlock" ? t("profiles.enterPin", { name: profile?.name ?? "" }) : pin.kind === "new" ? t("set.pinNew") : t("set.pinConfirm")}
                    error={pinError} resetKey={pinReset}
                    onComplete={(v) => { void onPin(v); }}
                    onCancel={() => { setPin(null); setPinError(null); }} />
            )}
            <Dialog open={confirmDelete} destructive icon="alert" title={t("set.deleteTitle", { name: profile?.name ?? "" })}
                message={t("set.deleteMsg")} confirmLabel={t("set.delete")}
                onConfirm={() => { void remove(); }} onCancel={() => setConfirmDelete(false)} testId="profile-delete" />
        </div>
    );
}
