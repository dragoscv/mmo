/**
 * Musical key as a Camelot-coloured chip, with an optional compatibility mark against a
 * reference key (the master deck's, or the playing deck's in the library).
 *
 * The mark is never colour only: its shape differs per level (dot / diamond / hollow square)
 * and the accessible name spells the relation out.
 */
import { camelotColors } from "@mmo/design-tokens";
import { cn } from "@mmo/ui";
import { keyCompatibility, parseCamelot } from "@/lib/harmonic";
import { useT } from "@/i18n";

const KEY_COLORS = camelotColors();

export type KeyMatch = "match" | "near" | "clash";

/** How well `key` mixes with `against` (null when either is unknown). */
export function keyMatch(key: string | null | undefined, against: string | null | undefined): KeyMatch | null {
    const a = parseCamelot(key);
    const b = parseCamelot(against);
    if (!a || !b) return null;
    const score = keyCompatibility(b, a).score;
    return score >= 0.85 ? "match" : score >= 0.45 ? "near" : "clash";
}

/** Camelot colour of a key label ("8A"), or undefined for an unknown key. */
export function keyColor(key: string | null | undefined): string | undefined {
    const k = parseCamelot(key);
    return k ? KEY_COLORS[`${k.number}${k.letter}`] : undefined;
}

export function KeyChip({
    keyName,
    against,
    className,
    title,
}: {
    /** Camelot label ("8A"); null / unknown renders a neutral dash chip. */
    keyName: string | null | undefined;
    /** Reference key for the compatibility mark; omit for no mark. */
    against?: string | null;
    className?: string;
    title?: string;
}) {
    const t = useT();
    const color = keyColor(keyName);
    const match = against ? keyMatch(keyName, against) : null;
    const label = !keyName
        ? t("deck.unknownKey")
        : match
          ? t(match === "match" ? "look.keyMatch" : match === "near" ? "look.keyNear" : "look.keyClash", { key: keyName, other: against ?? "" })
          : t("deck.trackKey", { key: keyName });
    return (
        <span role="img" aria-label={label} title={title ?? label} className={cn("dk-key", className)} style={color ? { ["--key" as string]: color } : undefined}>
            {keyName ?? "—"}
            {match && <span aria-hidden className="dk-key-dot" data-match={match} />}
        </span>
    );
}
