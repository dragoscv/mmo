/**
 * Pure Live TV source form logic (WP16-41): form state ↔ `LiveTvSourceInput` and client-side checks that
 * mirror `LiveTvService.validateInput` on the server (which stays authoritative; its `{error}` is shown too).
 */
import type { LiveTvSource, LiveTvSourceInput, LiveTvSourceKind } from "@/lib/mmo/media-types";

export const SOURCE_KINDS: readonly LiveTvSourceKind[] = ["m3u", "xtream", "hdhomerun"];

export interface SourceFormState {
    id: string | null;
    kind: LiveTvSourceKind;
    name: string;
    url: string;
    xmltvUrl: string;
    username: string;
    password: string;
    hasPassword: boolean;
    enabled: boolean;
    refreshHours: string;
    tunerLimit: string;
}

export const emptySourceForm = (): SourceFormState => ({
    id: null, kind: "m3u", name: "", url: "", xmltvUrl: "", username: "", password: "", hasPassword: false,
    enabled: true, refreshHours: "24", tunerLimit: "",
});

export function formFromSource(s: LiveTvSource): SourceFormState {
    return {
        id: s.id, kind: s.kind, name: s.name, url: s.url, xmltvUrl: s.xmltvUrl ?? "", username: s.username ?? "", password: "",
        hasPassword: s.hasPassword, enabled: s.enabled, refreshHours: String(s.refreshHours), tunerLimit: s.tunerLimit ? String(s.tunerLimit) : "",
    };
}

/** Form → request body. Edit omits `kind` (immutable server-side); an empty password keeps the stored one. */
export function toSourceInput(f: SourceFormState): LiveTvSourceInput {
    const body: LiveTvSourceInput = {
        name: f.name.trim(),
        url: f.url.trim(),
        enabled: f.enabled,
        refreshHours: Number(f.refreshHours) || 24,
    };
    if (!f.id) body.kind = f.kind;
    if (f.kind !== "hdhomerun") body.xmltvUrl = f.xmltvUrl.trim() || null;
    if (f.kind === "xtream") {
        body.username = f.username.trim() || null;
        if (f.password || !f.id) body.password = f.password || null;
    }
    if (f.tunerLimit.trim()) body.tunerLimit = Number(f.tunerLimit);
    return body;
}

/** Field keys with a problem (same rules as the server's validateInput). */
export function validateSourceForm(f: SourceFormState): string[] {
    const errs: string[] = [];
    if (!f.name.trim() || f.name.length > 200) errs.push("name");
    if (!f.url.trim() || f.url.length > 4096) errs.push("url");
    if (f.kind === "xtream" && !f.username.trim()) errs.push("username");
    if (f.kind === "xtream" && !f.password && !f.hasPassword) errs.push("password");
    const rh = Number(f.refreshHours);
    if (!Number.isInteger(rh) || rh < 1 || rh > 720) errs.push("refreshHours");
    if (f.tunerLimit.trim()) {
        const tl = Number(f.tunerLimit);
        if (!Number.isInteger(tl) || tl < 1 || tl > 64) errs.push("tunerLimit");
    }
    return errs;
}
