/**
 * Settings file format (pure, no React, no path aliases — unit-tested with
 * `node --test src/settings/settings-io.test.ts`).
 *
 * v2 file: `{ format, v: 2, exportedAt, app, sections: { appearance?, layout?, ... } }`.
 * v1 blob = the old profile backup (lib/profile.ts exportProfile) and is
 * migrated on import. Values inside sections stay plain JSON here; the live
 * layer (settings-live.ts) validates them against each store when applying.
 */

export const SETTINGS_FORMAT = "mixai-decks-settings";
export const SETTINGS_VERSION = 2;

/** Sections of a settings file, in display order. */
export const SECTION_IDS = ["appearance", "layout", "audio", "midi", "hid", "keyboard", "plugins", "library"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

/** `library` holds the companion device token: never exported unless asked. */
export const SENSITIVE_SECTIONS: readonly SectionId[] = ["library"];

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type Sections = Partial<Record<SectionId, JsonValue>>;

export interface SettingsFile {
    format: typeof SETTINGS_FORMAT;
    v: 2;
    exportedAt: string;
    app: string;
    sections: Sections;
}

export interface DiffEntry {
    section: SectionId;
    /** Dotted path inside the section (`mode`, `mappings[2].action`); "" = whole section. */
    path: string;
    before: JsonValue | undefined;
    after: JsonValue | undefined;
}

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-clone through JSON so stored values never alias live store objects. */
export function toJson(v: unknown): JsonValue | undefined {
    if (v === undefined) return undefined;
    try {
        return JSON.parse(JSON.stringify(v)) as JsonValue;
    } catch {
        return undefined;
    }
}

/** Keep only known sections with a defined value. */
export function cleanSections(raw: unknown): Sections {
    const out: Sections = {};
    if (!isObj(raw)) return out;
    for (const id of SECTION_IDS) {
        if (!(id in raw)) continue;
        const v = toJson(raw[id]);
        if (v !== undefined) out[id] = v;
    }
    return out;
}

/** Map the v1 profile blob (`{v:1, prefs, deckCount, companion, midiPreset, hidPreset, externalPlugins, keybinds}`) to sections. */
export function sectionsFromV1(d: Record<string, unknown>): Sections {
    const s: Sections = {};
    if (isObj(d.prefs)) s.appearance = toJson(d.prefs) ?? null;
    else if (typeof d.theme === "string") {
        const surface = d.theme === "flat-pro" ? "flat" : d.theme === "studio-metal" ? "solid" : d.theme === "neon-glass" ? "glass" : null;
        if (surface) s.appearance = { surface };
    }
    const layout: Record<string, JsonValue> = {};
    if (d.deckCount === 2 || d.deckCount === 4) layout.deckCount = d.deckCount;
    if (isObj(d.layout)) layout.state = toJson(d.layout) ?? null;
    if (Object.keys(layout).length > 0) s.layout = layout;
    if (isObj(d.companion)) s.library = toJson(d.companion) ?? null;
    if ("midiPreset" in d && d.midiPreset !== undefined) s.midi = toJson(d.midiPreset) ?? null;
    if (isObj(d.hidPreset)) s.hid = toJson(d.hidPreset) ?? null;
    if (Array.isArray(d.externalPlugins)) s.plugins = { external: toJson(d.externalPlugins) ?? [] };
    if (isObj(d.keybinds)) s.keyboard = toJson(d.keybinds) ?? {};
    return s;
}

/**
 * Accept a parsed v2 file or a v1 profile blob (object or JSON string) and
 * return a v2 file. Null when nothing recognisable is inside.
 */
export function migrate(raw: unknown): SettingsFile | null {
    let data: unknown = raw;
    if (typeof raw === "string") {
        try {
            data = JSON.parse(raw);
        } catch {
            return null;
        }
    }
    if (!isObj(data)) return null;
    if (data.format === SETTINGS_FORMAT) {
        if (typeof data.v !== "number" || data.v > SETTINGS_VERSION) return null;
        const sections = cleanSections(data.sections);
        if (Object.keys(sections).length === 0) return null;
        return {
            format: SETTINGS_FORMAT,
            v: 2,
            exportedAt: typeof data.exportedAt === "string" ? data.exportedAt : "",
            app: typeof data.app === "string" ? data.app : "",
            sections,
        };
    }
    if (data.v === 1 || data.v === undefined) {
        const sections = sectionsFromV1(data);
        if (Object.keys(sections).length === 0) return null;
        return { format: SETTINGS_FORMAT, v: 2, exportedAt: "", app: "", sections };
    }
    return null;
}

/** Keep only the picked sections. */
export function pickSections(sections: Sections, picked: readonly SectionId[]): Sections {
    const out: Sections = {};
    for (const id of picked) if (sections[id] !== undefined) out[id] = sections[id];
    return out;
}

/**
 * The `appearance` section = shared theme prefs (flat, as in v1 and early v2
 * files) plus optional `shell` (shell-prefs object) and `skin` (active skin id
 * or null). Files without `shell`/`skin` leave those untouched on apply.
 */
export interface AppearanceParts {
    prefs: Record<string, JsonValue>;
    shell?: Record<string, JsonValue>;
    skin?: string | null;
}

/** Shell keys that are per-machine state, never exported or applied. */
export const SHELL_LOCAL_KEYS = ["onboarded"] as const;

export function splitAppearance(v: JsonValue | undefined): AppearanceParts {
    if (!isObj(v)) return { prefs: {} };
    const { shell, skin, ...prefs } = v as Record<string, JsonValue>;
    const out: AppearanceParts = { prefs };
    if (isObj(shell)) {
        const s = { ...(shell as Record<string, JsonValue>) };
        for (const k of SHELL_LOCAL_KEYS) delete s[k];
        out.shell = s;
    }
    if (typeof skin === "string" && skin.length > 0 && skin.length <= 200) out.skin = skin;
    else if (skin === null) out.skin = null;
    return out;
}

export function joinAppearance(parts: { prefs: unknown; shell?: unknown; skin?: string | null }): JsonValue {
    const prefs = toJson(parts.prefs);
    const out: Record<string, JsonValue> = isObj(prefs) ? { ...(prefs as Record<string, JsonValue>) } : {};
    const shell = toJson(parts.shell);
    if (isObj(shell)) {
        const s = { ...(shell as Record<string, JsonValue>) };
        for (const k of SHELL_LOCAL_KEYS) delete s[k];
        out.shell = s;
    }
    if (parts.skin !== undefined) out.skin = parts.skin;
    return out;
}

/** Sections an export includes by default (everything but sensitive ones). */
export function defaultExportSections(available: readonly SectionId[] = SECTION_IDS): SectionId[] {
    return available.filter((id) => !SENSITIVE_SECTIONS.includes(id));
}

/**
 * Build a v2 file. `picked` defaults to every non-sensitive section, so the
 * library credential is excluded unless the caller asks for it explicitly.
 */
export function buildFile(
    sections: Sections,
    opts: { app: string; now?: Date; picked?: readonly SectionId[] },
): SettingsFile {
    const picked = opts.picked ?? defaultExportSections();
    return {
        format: SETTINGS_FORMAT,
        v: 2,
        exportedAt: (opts.now ?? new Date()).toISOString(),
        app: opts.app,
        sections: pickSections(sections, picked),
    };
}

/** `mixai-decks-settings-YYYY-MM-DD.json` (local date). */
export function exportFileName(now: Date = new Date()): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `mixai-decks-settings-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.json`;
}

function walk(section: SectionId, path: string, a: JsonValue | undefined, b: JsonValue | undefined, out: DiffEntry[]): void {
    if (Array.isArray(a) && Array.isArray(b)) {
        const n = Math.max(a.length, b.length);
        for (let i = 0; i < n; i++) walk(section, `${path}[${i}]`, a[i], b[i], out);
        return;
    }
    if (isObj(a) && isObj(b)) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of [...keys].sort()) walk(section, path ? `${path}.${k}` : k, a[k] as JsonValue, b[k] as JsonValue, out);
        return;
    }
    if (a === b) return;
    if (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b)) return;
    out.push({ section, path, before: a, after: b });
}

/**
 * Changed leaves between the live sections and an incoming file. Only
 * sections present in `incoming` are compared (absent = untouched on apply).
 */
export function diff(current: Sections, incoming: Sections): DiffEntry[] {
    const out: DiffEntry[] = [];
    for (const id of SECTION_IDS) {
        if (incoming[id] === undefined) continue;
        walk(id, "", current[id], incoming[id], out);
    }
    return out;
}

/** Group diff entries by section (sections without changes get an empty list). */
export function groupDiff(entries: readonly DiffEntry[], sections: readonly SectionId[]): Record<SectionId, DiffEntry[]> {
    const out = Object.fromEntries(SECTION_IDS.map((id) => [id, [] as DiffEntry[]])) as Record<SectionId, DiffEntry[]>;
    for (const e of entries) if (sections.includes(e.section)) out[e.section].push(e);
    return out;
}

/** Short human text for a diff value. */
export function formatValue(v: JsonValue | undefined, max = 48): string {
    if (v === undefined) return "—";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
