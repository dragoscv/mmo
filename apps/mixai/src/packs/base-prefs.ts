/**
 * Theme prefs while a skin is on (pure; the storage and DOM side is in pack-store.ts).
 *
 * A skin may override five theme dimensions. For those, and only those, the value the user had
 * before the skin is remembered (the "base") and put back when the skin goes away. Everything
 * else (language, reduced motion, feedback, a dimension the skin does not set) always comes
 * from the saved prefs, so a change made in Settings while a skin is on is never undone.
 */

/** The theme dimensions a skin may set. */
export const SKIN_PREF_KEYS = ["mode", "accent", "surface", "density", "radius"] as const;
export type SkinPrefKey = (typeof SKIN_PREF_KEYS)[number];

type Dims = Record<SkinPrefKey, unknown>;
/** The user's own value of every dimension the active skin overrides. */
export type BasePrefs<P extends Dims> = Partial<Pick<P, SkinPrefKey>>;
/** What a skin asks for (already validated by `tokensToCss`). */
export type SkinPrefs = Partial<Record<SkinPrefKey, unknown>>;

/**
 * Read a stored base. Keeps the five skin dimensions only (a snapshot written by an earlier
 * build held every pref) and only values `normalize` accepts; anything else, including text
 * that is not JSON, gives null instead of throwing.
 */
export function parseBasePrefs<P extends Dims>(raw: string | null | undefined, normalize: (input: unknown) => P): BasePrefs<P> | null {
    if (!raw) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const src = parsed as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let any = false;
    for (const k of SKIN_PREF_KEYS) {
        if (!Object.hasOwn(src, k)) continue;
        // `normalize` swaps a value it does not know for the default: only an unchanged value is valid.
        if (normalize({ [k]: src[k] })[k] !== src[k]) continue;
        out[k] = src[k];
        any = true;
    }
    return any ? (out as BasePrefs<P>) : null;
}

/** The user's prefs with no skin: the saved prefs with the remembered dimensions put back. */
export function withoutSkin<P extends Dims>(saved: P, base: BasePrefs<P> | null): P {
    return base ? { ...saved, ...base } : saved;
}

/**
 * One render of `skin` (null = no skin) over the saved prefs.
 *
 * - `next`: the prefs to show, and to save when the render is persisted.
 * - `base`: what to remember from now on: the user's value of each dimension `skin` sets
 *   (null = nothing to remember). Dimensions the previous skin set and this one does not go
 *   back to the user's value and leave the base, so they follow Settings again.
 *
 * Rendering the same skin again (a restart) changes nothing.
 */
export function skinPrefsStep<P extends Dims>(saved: P, base: BasePrefs<P> | null, skin: SkinPrefs | null): { next: P; base: BasePrefs<P> | null } {
    const user = withoutSkin(saved, base);
    if (!skin) return { next: user, base: null };
    const next: Record<string, unknown> = { ...user };
    const kept: Record<string, unknown> = {};
    let any = false;
    for (const k of SKIN_PREF_KEYS) {
        if (skin[k] === undefined) continue;
        kept[k] = user[k];
        next[k] = skin[k];
        any = true;
    }
    return { next: next as P, base: any ? (kept as BasePrefs<P>) : null };
}
