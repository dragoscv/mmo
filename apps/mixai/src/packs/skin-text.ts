/**
 * User-visible name and description of a skin. Built-in skins carry English text in their
 * manifest (the pack format has one language); their translations live in
 * `i18n/messages-skins.ts` under `skins.b.<slug>.name` / `.desc`. Installed packs show the
 * text their author wrote.
 */
import type { PackInfo } from "../bridge/packs.ts";

const BUILTIN_PREFIX = "ro.mixai.skin.";

/** `t` returns the key itself when a catalogue has no such entry. */
type Lookup = (key: never) => string;

function builtinText(t: Lookup, p: PackInfo, part: "name" | "desc"): string | null {
    if (p.sha256 !== "builtin" || !p.manifest.id.startsWith(BUILTIN_PREFIX)) return null;
    const key = `skins.b.${p.manifest.id.slice(BUILTIN_PREFIX.length)}.${part}`;
    const text = (t as (key: string) => string)(key);
    return text && text !== key ? text : null;
}

export function skinName(t: Lookup, p: PackInfo): string {
    return builtinText(t, p, "name") ?? p.manifest.name;
}

export function skinDescription(t: Lookup, p: PackInfo): string {
    return builtinText(t, p, "desc") ?? p.manifest.description;
}
