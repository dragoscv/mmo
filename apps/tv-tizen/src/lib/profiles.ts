/**
 * Viewer profiles owned by MMO Server (`/media/profiles*`, WP16-02). Mirrors tv-android
 * `data/ProfileRepository.kt`: holds the active profile + its 12 h unlock token, persisted in
 * localStorage `mixai-tv:profile` = `{id, token, expiresAt}`. Every profile-scoped request uses
 * `profileId` for `?profile=` and `headers()` for `x-profile-token`.
 */
import { ApiError } from "./api";
import type { ServerConfig } from "./config";
import { Emitter } from "./emitter";
import { ServerHttp, enc } from "./http";
import type { Profile, ProfileInput } from "./media-types";

export const PROFILE_KEY = "mixai-tv:profile";
export const DEFAULT_PROFILE_ID = "default";

export type UnlockResult =
    | { ok: true; profile: Profile }
    | { ok: false; reason: "wrong"; triesLeft: number | null }
    | { ok: false; reason: "locked"; retryAfterMs: number }
    | { ok: false; reason: "error"; message: string };

interface Stored { id: string; token: string; expiresAt: number }

function readStored(): Stored | null {
    try {
        const raw = localStorage.getItem(PROFILE_KEY);
        if (!raw) return null;
        const j = JSON.parse(raw) as Partial<Stored>;
        if (typeof j.id !== "string" || !j.id) return null;
        return { id: j.id, token: typeof j.token === "string" ? j.token : "", expiresAt: typeof j.expiresAt === "number" ? j.expiresAt : 0 };
    } catch {
        return null;
    }
}

function writeStored(s: Stored | null): void {
    try {
        if (s) localStorage.setItem(PROFILE_KEY, JSON.stringify(s));
        else localStorage.removeItem(PROFILE_KEY);
    } catch { /* storage disabled */ }
}

export class ProfilesClient {
    private readonly http: ServerHttp;
    private list: Profile[] = [];
    private activeProfile: Profile | null = null;
    private stored: Stored | null = readStored();
    /** Fires on active-profile change and list refresh. */
    readonly changed = new Emitter<Profile | null>();

    constructor(cfg: ServerConfig) {
        this.http = new ServerHttp(cfg);
    }

    /** Last fetched list (sorted by `sort`, then `createdAt`). */
    get profiles(): Profile[] { return this.list; }
    get active(): Profile | null { return this.activeProfile; }
    /** Id for `?profile=` — the stored id even before the list loads, else `default`. */
    get profileId(): string { return this.activeProfile?.id ?? this.stored?.id ?? DEFAULT_PROFILE_ID; }
    /** Valid profile token or "". */
    get token(): string {
        const s = this.stored;
        return s && s.token && s.expiresAt > Date.now() && s.id === this.profileId ? s.token : "";
    }
    /** `{ "x-profile-token": … }` when a valid token exists. */
    headers(): Record<string, string> {
        const t = this.token;
        return t ? { "x-profile-token": t } : {};
    }
    /** `profile=<id>` query fragment (URL-encoded). */
    query(): string { return `profile=${enc(this.profileId)}`; }

    async refresh(): Promise<Profile[]> {
        const r = await this.http.must(this.http.get<{ revision: number; profiles: Profile[] }>("/media/profiles"));
        this.list = [...r.profiles].sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);
        const id = this.activeProfile?.id ?? this.stored?.id;
        this.activeProfile = (id && this.list.find((p) => p.id === id)) || null;
        this.changed.emit(this.activeProfile);
        return this.list;
    }

    /**
     * Restores the persisted profile. True when it still exists and is usable without a PIN prompt
     * (no PIN, or a still-valid token). On an older server (404) behaves like a single `default` profile.
     */
    async restore(): Promise<boolean> {
        try {
            await this.refresh();
        } catch (e) {
            if (e instanceof ApiError && e.status === 404) return true;
            // Offline: keep the stored id so cached Home still works.
            return !!this.stored;
        }
        const p = this.activeProfile;
        if (!p) return false;
        return !p.hasPin || this.token !== "";
    }

    /**
     * Startup must show the picker: more than one profile, no usable active profile, or the active one has a
     * PIN without a valid token. A single PIN-less profile is auto-selected instead. Empty list (server
     * without profiles) → false.
     */
    needsPicker(): boolean {
        if (this.list.length === 0) return false;
        if (this.list.length > 1) return true;
        const only = this.list[0]!;
        if (!this.activeProfile && !only.hasPin) { this.select(only); return false; }
        const p = this.activeProfile ?? only;
        return p.hasPin && this.token === "";
    }

    /** Activate a profile without a PIN (or whose token is still valid). */
    select(p: Profile): void {
        const keep = this.stored && this.stored.id === p.id && this.stored.expiresAt > Date.now() ? this.stored : null;
        this.stored = keep ?? { id: p.id, token: "", expiresAt: 0 };
        this.activeProfile = p;
        writeStored(this.stored);
        this.changed.emit(p);
    }

    /** `POST /media/profiles/{id}/unlock` (PIN optional when the profile has none); activates on success. */
    async unlock(p: Profile, pin?: string): Promise<UnlockResult> {
        try {
            const r = await this.http.must(this.http.post<{ token: string; expiresAt: number }>(`/media/profiles/${enc(p.id)}/unlock`, pin ? { pin } : {}));
            this.stored = { id: p.id, token: r.token, expiresAt: r.expiresAt };
            this.activeProfile = p;
            writeStored(this.stored);
            this.changed.emit(p);
            return { ok: true, profile: p };
        } catch (e) {
            if (e instanceof ApiError) {
                const b = (e.body ?? {}) as { triesLeft?: number; retryAfterMs?: number };
                if (e.status === 401) return { ok: false, reason: "wrong", triesLeft: typeof b.triesLeft === "number" ? b.triesLeft : null };
                if (e.status === 429) return { ok: false, reason: "locked", retryAfterMs: typeof b.retryAfterMs === "number" ? b.retryAfterMs : 300_000 };
            }
            return { ok: false, reason: "error", message: (e as Error).message };
        }
    }

    async create(input: ProfileInput): Promise<Profile> {
        const r = await this.http.must(this.http.post<{ profile: Profile }>("/media/profiles", input));
        await this.refresh().catch(() => undefined);
        return r.profile;
    }

    /** Needs the profile's token when it has a PIN (unlock first). */
    async update(id: string, input: ProfileInput): Promise<Profile> {
        const h = id === this.profileId ? this.headers() : {};
        const r = await this.http.must(this.http.patch<{ profile: Profile }>(`/media/profiles/${enc(id)}`, input, { headers: h }));
        await this.refresh().catch(() => undefined);
        return r.profile;
    }

    async remove(id: string): Promise<void> {
        const h = id === this.profileId ? this.headers() : {};
        await this.http.del(`/media/profiles/${enc(id)}`, { headers: h });
        if (this.profileId === id) this.signOut();
        await this.refresh().catch(() => undefined);
    }

    /** Forget the active profile ("Switch profile"). */
    signOut(): void {
        this.stored = null;
        this.activeProfile = null;
        writeStored(null);
        this.changed.emit(null);
    }
}
