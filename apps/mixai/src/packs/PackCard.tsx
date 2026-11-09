/**
 * One pack tile, shared by Settings → Appearance (skins) and the Marketplace.
 * The selectable area is its own button; actions sit beside it (never nested
 * buttons). Colours in the palette strip come from validated pack tokens and
 * are re-checked with `isSafeColor`; packs without colours show the live theme.
 */
import type { ReactNode } from "react";
import { AlertTriangle, BadgeCheck, Check, ShieldCheck, ShieldQuestion, Users } from "lucide-react";
import { Badge, cn } from "@mmo/ui";
import type { PackTokens, PackTrust } from "@/bridge/packs";
import { useT } from "@/i18n";
import { contrastProblems, isSafeColor } from "./apply-tokens";

export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const TRUST_ICON = { official: BadgeCheck, verified: ShieldCheck, community: Users, unsigned: ShieldQuestion } as const;
const TRUST_KEY = { official: "pack.trustOfficial", verified: "pack.trustVerified", community: "pack.trustCommunity", unsigned: "pack.trustUnsigned" } as const;
const TRUST_VARIANT = { official: "default", verified: "info", community: "secondary", unsigned: "warning" } as const;

export function TrustBadge({ trust }: { trust: PackTrust }) {
    const t = useT();
    const Icon = TRUST_ICON[trust];
    return (
        <Badge variant={TRUST_VARIANT[trust]} title={trust === "unsigned" ? t("pack.trustUnsignedHint") : undefined}>
            <Icon aria-hidden /> {t(TRUST_KEY[trust])}
        </Badge>
    );
}

/** Up to six colours: background, primary, decks a..d. Theme vars when the pack sets none. */
export function paletteOf(tokens: PackTokens | undefined): string[] {
    const c = tokens?.colors ?? {};
    const d = tokens?.decks ?? {};
    const pick = [c.background, c.primary, d.a ?? c["deck-a"], d.b ?? c["deck-b"], d.c ?? c["deck-c"], d.d ?? c["deck-d"]];
    const vars = ["var(--background)", "var(--primary)", "var(--deck-a)", "var(--deck-b)", "var(--deck-c)", "var(--deck-d)"];
    return pick.map((v, i) => (isSafeColor(v) ? v.trim() : vars[i]!));
}

export function PaletteStrip({ tokens, className }: { tokens: PackTokens | undefined; className?: string }) {
    return (
        <div aria-hidden className={cn("flex h-6 overflow-hidden rounded-md border border-border", className)}>
            {paletteOf(tokens).map((bg, i) => (
                <span key={i} className="flex-1" style={{ background: bg }} />
            ))}
        </div>
    );
}

export function ContrastBadge({ tokens }: { tokens: PackTokens | undefined }) {
    const t = useT();
    const problems = tokens ? contrastProblems(tokens) : [];
    if (problems.length === 0) return null;
    const detail = problems.map((p) => t("pack.contrastPair", { fg: p.fg, bg: p.bg, ratio: p.ratio.toFixed(1), need: p.need })).join("; ");
    return (
        <Badge variant="warning" title={detail}>
            <AlertTriangle aria-hidden /> {t("pack.contrast")}
            <span className="sr-only">: {detail}</span>
        </Badge>
    );
}

export interface PackCardProps {
    name: string;
    author: string;
    trust?: PackTrust;
    tokens?: PackTokens;
    /** Image URL (data: or https) for marketplace previews. */
    previewSrc?: string | null;
    pro?: boolean;
    size?: number;
    active?: boolean;
    /** Selecting the card (apply). Omit for non-selectable cards. */
    onSelect?: () => void;
    selectLabel?: string;
    description?: string;
    actions?: ReactNode;
    /** Inline status / error under the actions (rendered inside role=status by the caller if needed). */
    footer?: ReactNode;
    settingId?: string;
}

export function PackCard({ name, author, trust, tokens, previewSrc, pro, size, active, onSelect, selectLabel, description, actions, footer, settingId }: PackCardProps) {
    const t = useT();
    const body = (
        <>
            {previewSrc ? (
                <img src={previewSrc} alt={t("pack.previewAlt", { name })} loading="lazy" className="aspect-video w-full rounded-md border border-border object-cover" />
            ) : (
                <PaletteStrip tokens={tokens} />
            )}
            <span className="flex min-w-0 items-start justify-between gap-2">
                <span className="grid min-w-0">
                    <span className="truncate text-sm font-semibold">{name}</span>
                    <span className="truncate text-xs text-muted-foreground">{t("pack.by", { author })}</span>
                </span>
                {active ? (
                    <Badge variant="success">
                        <Check aria-hidden /> {t("pack.active")}
                    </Badge>
                ) : null}
            </span>
            {description ? <span className="line-clamp-2 text-xs text-muted-foreground">{description}</span> : null}
        </>
    );
    return (
        <article
            data-setting-id={settingId}
            className={cn(
                "surface flex min-w-0 flex-col gap-2 rounded-xl border p-3 transition-colors duration-(--dur-fast)",
                active ? "border-primary" : "border-border",
            )}
        >
            {onSelect ? (
                <button
                    type="button"
                    aria-pressed={!!active}
                    aria-label={selectLabel}
                    onClick={onSelect}
                    className="grid min-h-6 cursor-pointer gap-2 rounded-lg text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
                >
                    {body}
                </button>
            ) : (
                <div className="grid gap-2">{body}</div>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
                {trust ? <TrustBadge trust={trust} /> : null}
                {pro ? <Badge variant="gradient">{t("pack.pro")}</Badge> : null}
                {size ? <span className="text-xs text-muted-foreground">{formatBytes(size)}</span> : null}
                <ContrastBadge tokens={tokens} />
            </div>
            {actions ? <div className="mt-auto flex flex-wrap gap-2">{actions}</div> : null}
            {footer}
        </article>
    );
}
