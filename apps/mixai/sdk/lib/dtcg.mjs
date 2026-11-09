// DTCG / Figma Tokens Studio export -> pack tokens.json.
import { COLOR_KEYS, normalizeColor } from "./color.mjs";

/** Common design-tool names -> allow-listed pack keys (compared after normalisation). */
const ALIASES = {
    bg: "background", "background-default": "background", "bg-default": "background", surface: "background", canvas: "background", base: "background",
    text: "foreground", fg: "foreground", "text-default": "foreground", "text-primary": "foreground", "on-background": "foreground", "on-surface": "foreground",
    brand: "primary", "brand-primary": "primary", "primary-default": "primary",
    "on-primary": "primary-foreground", "text-on-primary": "primary-foreground", "brand-foreground": "primary-foreground", "on-brand": "primary-foreground",
    "on-secondary": "secondary-foreground",
    "on-accent": "accent-foreground",
    "surface-raised": "card", panel: "card", "bg-card": "card", "on-card": "card-foreground", "text-card": "card-foreground",
    "bg-popover": "popover", "on-popover": "popover-foreground",
    "text-muted": "muted-foreground", "text-secondary": "muted-foreground", subtle: "muted-foreground", "bg-muted": "muted",
    error: "destructive", danger: "destructive", "bg-error": "destructive",
    outline: "border", stroke: "border", divider: "border",
    "input-border": "input", field: "input",
    focus: "ring", "focus-ring": "ring",
    ok: "success", positive: "success",
    caution: "warning",
    "deck-1": "deck-a", "deck-2": "deck-b", "deck-3": "deck-c", "deck-4": "deck-d",
    "decka": "deck-a", "deckb": "deck-b", "deckc": "deck-c", "deckd": "deck-d",
};

const GROUP_PREFIXES = ["color", "colors", "colour", "colours", "palette", "semantic", "theme", "sys", "system", "global", "tokens"];

function normName(s) {
    return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[\s_.]+/g, "-").toLowerCase();
}

/** Map a token path (array of segments) to an allow-listed key, or null. */
export function mapTokenName(path) {
    const segs = path.map(normName);
    while (segs.length > 1 && GROUP_PREFIXES.includes(segs[0])) segs.shift();
    const candidates = [segs.join("-"), segs[segs.length - 1]];
    // "deck/a" -> "deck-a"
    if (segs.length >= 2 && segs[segs.length - 2] === "deck") candidates.unshift(`deck-${segs[segs.length - 1]}`);
    // "primary/foreground" -> "primary-foreground"; "primary/default" -> "primary"
    if (segs.length >= 2) {
        const last2 = segs.slice(-2);
        candidates.unshift(last2.join("-"));
        if (["default", "base", "500", "main", "value"].includes(last2[1])) candidates.push(last2[0]);
    }
    for (const c of candidates) {
        if (COLOR_KEYS.includes(c)) return c;
        if (ALIASES[c]) return ALIASES[c];
    }
    return null;
}

/** Flatten nested DTCG groups into [{ path, value, type }]; `$type` is inherited from groups. */
export function flattenTokens(root) {
    const out = [];
    const walk = (node, path, inheritedType) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return;
        const type = typeof node.$type === "string" ? node.$type : inheritedType;
        if ("$value" in node) {
            out.push({ path, value: node.$value, type });
            return;
        }
        // Tokens Studio legacy: { value, type }
        if ("value" in node && ("type" in node) && typeof node.type === "string" && Object.keys(node).every((k) => ["value", "type", "description"].includes(k))) {
            out.push({ path, value: node.value, type: node.type });
            return;
        }
        for (const [k, v] of Object.entries(node)) {
            if (k.startsWith("$")) continue;
            walk(v, [...path, k], type);
        }
    };
    walk(root, [], undefined);
    return out;
}

/** Resolve `{group.token}` aliases (chains allowed, cycles detected). */
export function resolveAliases(flat) {
    const byPath = new Map(flat.map((t) => [t.path.join("."), t]));
    const resolve = (t, seen = new Set()) => {
        let v = t.value;
        const m = typeof v === "string" ? /^\{([^{}]+)\}$/.exec(v.trim()) : null;
        if (!m) return v;
        const key = m[1];
        if (seen.has(key)) throw new Error(`alias cycle at {${key}}`);
        const target = byPath.get(key);
        if (!target) throw new Error(`unresolved alias {${key}} in ${t.path.join(".")}`);
        seen.add(key);
        v = resolve(target, seen);
        return v;
    };
    return flat.map((t) => {
        try {
            const value = resolve(t);
            const target = typeof t.value === "string" && /^\{([^{}]+)\}$/.exec(t.value.trim());
            const type = t.type ?? (target ? byPath.get(target[1])?.type : undefined);
            return { ...t, value, type };
        } catch (e) {
            return { ...t, error: e.message };
        }
    });
}

/**
 * Convert a DTCG / Tokens Studio JSON object into pack tokens.
 * Returns { tokens, mapped: [{from, to, value}], unmapped: [path], problems: [msg] }.
 */
export function importDtcg(json, base = {}) {
    // Tokens Studio multi-set exports: { "global": {...}, "$themes": [...], "$metadata": {...} }
    const flat = resolveAliases(flattenTokens(json));
    const colors = {};
    const mapped = [];
    const unmapped = [];
    const problems = [];
    for (const t of flat) {
        const name = t.path.join(".");
        if (t.error) { problems.push(t.error); continue; }
        const looksColour = t.type === "color" || (t.type === undefined && typeof t.value === "string" && normalizeColor(t.value));
        if (!looksColour) { unmapped.push(name); continue; }
        const key = mapTokenName(t.path);
        if (!key) { unmapped.push(name); continue; }
        const value = normalizeColor(typeof t.value === "string" ? t.value : "");
        if (!value) { problems.push(`${name}: colour '${String(t.value).slice(0, 60)}' cannot be converted (use #hex, rgb(), hsl() or oklch())`); continue; }
        if (colors[key] && colors[key] !== value) problems.push(`${name}: '${key}' already set from another token, keeping the first`);
        else {
            colors[key] = value;
            mapped.push({ from: name, to: key, value });
        }
    }
    const tokens = { ...base };
    tokens.colors = { ...(base.colors ?? {}), ...colors };
    if (!Object.keys(tokens.colors).length) delete tokens.colors;
    return { tokens, mapped, unmapped, problems };
}
