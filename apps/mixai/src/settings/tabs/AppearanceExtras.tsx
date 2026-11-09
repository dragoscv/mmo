/**
 * Appearance extras under the shared ThemeSettings: skins (built-in +
 * installed + install from file), colour-blind deck palettes, accessibility
 * and motion/performance switches. Shell prefs live in `useShellPrefs`, skins
 * in `usePackStore`.
 */
import { useId, useState } from "react";
import { ExternalLink, FileUp, Play, Trash2 } from "lucide-react";
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    Button,
    RadioGroup,
    RadioGroupItem,
    Switch,
} from "@mmo/ui";
import { packs, type PackInfo } from "@/bridge/packs";
import { useT, type MessageKey } from "@/i18n";
import { BUILTIN_SKINS } from "@/packs/builtin-skins";
import { ContrastBadge, formatBytes, PackCard, TrustBadge } from "@/packs/PackCard";
import { contrastProblems } from "@/packs/apply-tokens";
import { usePackStore } from "@/packs/pack-store";
import { DECK_PALETTES, useShellPrefs, type DeckPalette, type ShellPrefs } from "@/shell/shell-prefs";
import { Section } from "../sections/shared";

export const DECKS_PRO_URL = "https://mixai.ro/decks/pro";

/** Swatches per palette (OKLCH copies of the deck colours: tokens.css brand + styles.css data-deck-palette blocks). */
const PALETTE_SWATCHES: Record<DeckPalette, string[]> = {
    brand: ["oklch(0.797 0.134 211.5)", "oklch(0.695 0.223 355.3)", "oklch(0.91 0.223 133.2)", "oklch(0.818 0.144 69.3)"],
    deuteranopia: ["oklch(0.75 0.11 237)", "oklch(0.77 0.16 70)", "oklch(0.86 0.17 100)", "oklch(0.64 0.13 260)"],
    protanopia: ["oklch(0.75 0.11 237)", "oklch(0.77 0.16 70)", "oklch(0.86 0.17 100)", "oklch(0.64 0.13 260)"],
    tritanopia: ["oklch(0.67 0.2 25)", "oklch(0.72 0.12 195)", "oklch(0.8 0.02 280)", "oklch(0.6 0.2 350)"],
    mono: ["oklch(0.92 0 0)", "oklch(0.72 0 0)", "oklch(0.58 0 0)", "oklch(0.46 0 0)"],
};

const PALETTE_LABEL: Record<DeckPalette, MessageKey> = {
    brand: "pack.paletteBrand",
    deuteranopia: "pack.paletteDeuteranopia",
    protanopia: "pack.paletteProtanopia",
    tritanopia: "pack.paletteTritanopia",
    mono: "pack.paletteMono",
};

/** Explanation + link shown when a Pro pack is refused. */
export function ProNotice() {
    const t = useT();
    return (
        <div role="status" className="grid gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
            <p className="font-semibold">{t("pack.proTitle")}</p>
            <p className="text-muted-foreground">{t("pack.proBody")}</p>
            <Button variant="default" size="sm" className="w-fit" render={<a href={DECKS_PRO_URL} target="_blank" rel="noreferrer" />}>
                {t("pack.proLink")} <ExternalLink aria-hidden />
            </Button>
        </div>
    );
}

/** Readable text for a pack-store / Rust refusal. */
export function PackError({ error }: { error: string | null }) {
    const t = useT();
    if (!error) return null;
    if (error === "pro" || error === "pro_required") return <ProNotice />;
    return (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {t("pack.refused", { detail: error.replace(/^Error:\s*/, "") })}
        </p>
    );
}

function SwitchRow({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
    const uid = useId();
    return (
        <div data-setting-id={id} className="flex scroll-mt-4 items-start justify-between gap-4 rounded-lg py-1 data-[highlight=true]:ring-2 data-[highlight=true]:ring-ring/60">
            <div className="grid gap-0.5">
                <label htmlFor={uid} className="cursor-pointer text-sm font-medium">
                    {label}
                </label>
                <p id={`${uid}-hint`} className="text-xs text-muted-foreground">
                    {hint}
                </p>
            </div>
            <Switch id={uid} aria-describedby={`${uid}-hint`} checked={checked} onCheckedChange={(v) => onChange(v)} className="mt-0.5" />
        </div>
    );
}

function isSkin(p: PackInfo): boolean {
    return (p.manifest.kind === "skin" || p.manifest.kind === "bundle") && !!p.tokens;
}

function SkinSection() {
    const t = useT();
    const installed = usePackStore((s) => s.installed);
    const activeSkin = usePackStore((s) => s.activeSkin);
    const error = usePackStore((s) => s.error);
    const [pending, setPending] = useState<{ info: PackInfo; bytes: Uint8Array } | null>(null);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [localError, setLocalError] = useState<string | null>(null);

    const store = usePackStore.getState;
    const skins = [...BUILTIN_SKINS, ...installed.filter((p) => isSkin(p) && !BUILTIN_SKINS.some((b) => b.manifest.id === p.manifest.id))];

    const pickFile = async () => {
        setNote(null);
        setLocalError(null);
        setBusy(true);
        try {
            const bytes = await packs.pickFile();
            if (!bytes) {
                if (!("__TAURI_INTERNALS__" in window)) setNote(t("pack.notNative"));
                return;
            }
            const info = await packs.inspect(bytes);
            if (!info) {
                setNote(t("pack.notNative"));
                return;
            }
            setPending({ info, bytes });
        } catch (e) {
            setLocalError(String(e));
        } finally {
            setBusy(false);
        }
    };

    const confirmInstall = async () => {
        if (!pending) return;
        const { bytes } = pending;
        setPending(null);
        setBusy(true);
        const done = await store().install(bytes);
        setBusy(false);
        if (done) {
            setNote(t("pack.installedDone", { name: done.manifest.name }));
            if (isSkin(done)) store().setActiveSkin(done.manifest.id);
        }
    };

    const tryPending = () => {
        if (!pending) return;
        store().startTry(pending.info, pending.bytes);
        setPending(null);
    };

    const problems = pending?.info.tokens ? contrastProblems(pending.info.tokens) : [];

    return (
        <Section title={t("pack.skinTitle")} settingId="appearance.skin">
            <p className="text-xs text-muted-foreground">{t("pack.skinHint")}</p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
                <PackCard
                    name={t("pack.defaultName")}
                    author="MixAI"
                    trust="official"
                    active={!activeSkin}
                    onSelect={() => store().setActiveSkin(null)}
                    selectLabel={t("pack.applyAria", { name: t("pack.defaultName") })}
                    description={t("pack.themeColours")}
                />
                {skins.map((p) => {
                    const builtin = BUILTIN_SKINS.includes(p);
                    return (
                        <PackCard
                            key={p.manifest.id}
                            name={p.manifest.name}
                            author={p.manifest.author}
                            trust={p.trust}
                            tokens={p.tokens}
                            active={activeSkin === p.manifest.id}
                            onSelect={() => store().setActiveSkin(p.manifest.id)}
                            selectLabel={t("pack.applyAria", { name: p.manifest.name })}
                            description={p.manifest.description}
                            actions={
                                <>
                                    <Button variant="outline" size="xs" aria-label={t("pack.tryAria", { name: p.manifest.name })} onClick={() => store().startTry(p, null)}>
                                        <Play aria-hidden /> {t("pack.try")}
                                    </Button>
                                    {builtin ? null : (
                                        <Button variant="ghost" size="xs" aria-label={t("pack.removeAria", { name: p.manifest.name })} onClick={() => void store().remove(p.manifest.id)}>
                                            <Trash2 aria-hidden /> {t("pack.remove")}
                                        </Button>
                                    )}
                                </>
                            }
                        />
                    );
                })}
            </div>
            <div className="flex flex-wrap items-center gap-3" data-setting-id="appearance.skinFile">
                <Button variant="outline" size="sm" onClick={() => void pickFile()} loading={busy}>
                    <FileUp aria-hidden /> {t("pack.installFile")}
                </Button>
                <p role="status" className="text-xs text-muted-foreground">
                    {note}
                </p>
            </div>
            <PackError error={error ?? localError} />

            <AlertDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
                <AlertDialogContent>
                    {pending ? (
                        <>
                            <AlertDialogHeader>
                                <AlertDialogTitle>{t("pack.confirmTitle", { name: pending.info.manifest.name })}</AlertDialogTitle>
                                <AlertDialogDescription>{t("pack.confirmBody")}</AlertDialogDescription>
                            </AlertDialogHeader>
                            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2 text-sm">
                                <dt className="text-muted-foreground">{t("pack.author")}</dt>
                                <dd>{pending.info.manifest.author}</dd>
                                <dt className="text-muted-foreground">{t("pack.version")}</dt>
                                <dd className="mono">{pending.info.manifest.version}</dd>
                                <dt className="text-muted-foreground">{t("pack.trust")}</dt>
                                <dd>
                                    <TrustBadge trust={pending.info.trust} />
                                </dd>
                                <dt className="text-muted-foreground">{t("pack.size")}</dt>
                                <dd>{formatBytes(pending.info.size || pending.bytes.byteLength)}</dd>
                            </dl>
                            {pending.info.trust === "unsigned" ? <p className="text-xs text-warning">{t("pack.trustUnsignedHint")}</p> : null}
                            {problems.length > 0 ? (
                                <div className="grid gap-1 text-xs">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <ContrastBadge tokens={pending.info.tokens} /> <span>{t("pack.contrastWarn")}</span>
                                    </div>
                                    <ul className="list-disc pl-5 text-muted-foreground">
                                        {problems.map((p) => (
                                            <li key={`${p.fg}-${p.bg}`}>{t("pack.contrastPair", { fg: p.fg, bg: p.bg, ratio: p.ratio.toFixed(1), need: p.need })}</li>
                                        ))}
                                    </ul>
                                </div>
                            ) : null}
                            <AlertDialogFooter>
                                <AlertDialogCancel>{t("pack.cancel")}</AlertDialogCancel>
                                {pending.info.tokens ? (
                                    <Button variant="outline" onClick={tryPending}>
                                        <Play aria-hidden /> {t("pack.try")}
                                    </Button>
                                ) : null}
                                <Button onClick={() => void confirmInstall()}>{t("pack.install")}</Button>
                            </AlertDialogFooter>
                        </>
                    ) : null}
                </AlertDialogContent>
            </AlertDialog>
        </Section>
    );
}

function PaletteSection() {
    const t = useT();
    const palette = useShellPrefs((s) => s.palette);
    const labelId = useId();
    return (
        <Section title={t("pack.paletteTitle")} settingId="appearance.deckPalette">
            <p id={labelId} className="text-xs text-muted-foreground">
                {t("pack.paletteHint")}
            </p>
            <RadioGroup<DeckPalette>
                aria-labelledby={labelId}
                value={palette}
                onValueChange={(v) => useShellPrefs.getState().set({ palette: v })}
                className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2"
            >
                {DECK_PALETTES.map((p) => (
                    <label key={p} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 has-data-checked:border-primary">
                        <RadioGroupItem value={p} />
                        <span className="grid gap-1">
                            <span className="text-sm">{t(PALETTE_LABEL[p])}</span>
                            <span aria-hidden className="flex gap-1">
                                {PALETTE_SWATCHES[p].map((c, i) => (
                                    <span key={i} className="size-4 rounded-sm border border-border" style={{ background: c }} />
                                ))}
                            </span>
                        </span>
                    </label>
                ))}
            </RadioGroup>
        </Section>
    );
}

type BoolKey = { [K in keyof ShellPrefs]: ShellPrefs[K] extends boolean ? K : never }[keyof ShellPrefs];

function Toggles({ title, settingId, rows }: { title: string; settingId: string; rows: { id: string; key: BoolKey; label: string; hint: string }[] }) {
    const prefs = useShellPrefs();
    return (
        <Section title={title} settingId={settingId}>
            <div className="grid gap-2">
                {rows.map((r) => (
                    <SwitchRow key={r.id} id={r.id} label={r.label} hint={r.hint} checked={prefs[r.key]} onChange={(v) => prefs.set({ [r.key]: v })} />
                ))}
            </div>
        </Section>
    );
}

export function AppearanceExtras() {
    const t = useT();
    return (
        <div className="grid gap-6">
            <SkinSection />
            <PaletteSection />
            <Toggles
                title={t("pack.a11yTitle")}
                settingId="appearance.a11y"
                rows={[
                    { id: "appearance.highContrast", key: "highContrast", label: t("pack.highContrast"), hint: t("pack.highContrastHint") },
                    { id: "appearance.touch", key: "touch", label: t("pack.touch"), hint: t("pack.touchHint") },
                ]}
            />
            <Toggles
                title={t("pack.motionTitle")}
                settingId="appearance.motionPerf"
                rows={[
                    { id: "appearance.beatAccent", key: "beatAccent", label: t("pack.beatAccent"), hint: t("pack.beatAccentHint") },
                    { id: "appearance.hud", key: "hud", label: t("pack.hud"), hint: t("pack.hudHint") },
                    { id: "appearance.governor", key: "governor", label: t("pack.governor"), hint: t("pack.governorHint") },
                ]}
            />
        </div>
    );
}
