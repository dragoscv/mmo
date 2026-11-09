/**
 * Settings profiles (Home / Club / Streaming + user ones) — pure helpers.
 * A profile stores v2 settings sections WITHOUT `library` (credential).
 */
import { SENSITIVE_SECTIONS, cleanSections, type Sections } from "./settings-io.ts";

export const PROFILES_KEY = "mixai-settings-profiles";
export const SEED_IDS = ["home", "club", "streaming"] as const;
export type ProfileIcon = "home" | "club" | "streaming" | "user";

export interface SettingsProfile {
    id: string;
    name: string;
    icon: ProfileIcon;
    data: Sections;
}

export interface ProfilesState {
    active: string | null;
    profiles: SettingsProfile[];
}

const SEED_NAMES: Record<(typeof SEED_IDS)[number], string> = { home: "Home", club: "Club", streaming: "Streaming" };

export function isSeed(id: string): boolean {
    return (SEED_IDS as readonly string[]).includes(id);
}

export function stripSensitive(data: Sections): Sections {
    const out = cleanSections(data);
    for (const id of SENSITIVE_SECTIONS) delete out[id];
    return out;
}

export function emptyProfiles(): ProfilesState {
    return { active: null, profiles: SEED_IDS.map((id) => ({ id, name: SEED_NAMES[id], icon: id, data: {} })) };
}

function isIcon(v: unknown): v is ProfileIcon {
    return v === "home" || v === "club" || v === "streaming" || v === "user";
}

/** Parse persisted state; seeds are always present (first, in order). */
export function normalizeProfiles(raw: unknown): ProfilesState {
    const base = emptyProfiles();
    if (!raw || typeof raw !== "object") return base;
    const r = raw as { active?: unknown; profiles?: unknown };
    const list: SettingsProfile[] = [];
    if (Array.isArray(r.profiles)) {
        for (const p of r.profiles) {
            if (!p || typeof p !== "object") continue;
            const o = p as Record<string, unknown>;
            if (typeof o.id !== "string" || !o.id || list.some((x) => x.id === o.id)) continue;
            list.push({
                id: o.id,
                name: typeof o.name === "string" && o.name.trim() ? o.name.slice(0, 40) : o.id,
                icon: isIcon(o.icon) ? o.icon : "user",
                data: stripSensitive(o.data as Sections),
            });
        }
    }
    const seeds = base.profiles.map((s) => list.find((p) => p.id === s.id) ?? s);
    const rest = list.filter((p) => !isSeed(p.id));
    const profiles = [...seeds, ...rest];
    const active = typeof r.active === "string" && profiles.some((p) => p.id === r.active) ? r.active : null;
    return { active, profiles };
}

export function upsertProfile(s: ProfilesState, p: SettingsProfile): ProfilesState {
    const clean = { ...p, data: stripSensitive(p.data) };
    const exists = s.profiles.some((x) => x.id === p.id);
    return { ...s, profiles: exists ? s.profiles.map((x) => (x.id === p.id ? clean : x)) : [...s.profiles, clean] };
}

/** Seeds cannot be deleted. */
export function removeProfile(s: ProfilesState, id: string): ProfilesState {
    if (isSeed(id)) return s;
    return { active: s.active === id ? null : s.active, profiles: s.profiles.filter((p) => p.id !== id) };
}

export function uniqueProfileId(s: ProfilesState, base: string): string {
    const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "profile";
    let id = slug;
    for (let i = 2; s.profiles.some((p) => p.id === id); i++) id = `${slug}-${i}`;
    return id;
}

export function isEmptyProfile(p: SettingsProfile): boolean {
    return Object.keys(p.data).length === 0;
}
