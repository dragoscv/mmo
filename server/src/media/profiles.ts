/**
 * Profiles (WP16-01): "Who's watching", optional 4-digit PIN, kids max age.
 * Owned by the MMO Server (D26). PIN = scrypt(N=16384) with a per-profile salt;
 * 5 wrong tries lock the profile for 5 minutes. Unlock returns a short-lived
 * HMAC profile token (12 h) that clients send as `x-profile-token`.
 */

import crypto from "node:crypto";
import type { MediaDb } from "./db";
import { getMeta, setMeta } from "./db";
import type { Profile, ProfileKind } from "./types";

export const PIN_MAX_TRIES = 5;
export const PIN_LOCK_MS = 5 * 60_000;
export const PROFILE_TOKEN_TTL_MS = 12 * 3600_000;
export const KID_DEFAULT_MAX_AGE = 12;
export const MAX_PROFILES = 12;

type Row = {
    id: string; name: string; avatar: string | null; color: string | null; kind: ProfileKind; max_age: number | null;
    pin_hash: string | null; prefs: string; sort: number; created_at: number; updated_at: number;
};

const toProfile = (r: Row): Profile => {
    let prefs: Record<string, unknown> = {};
    try { prefs = JSON.parse(r.prefs) as Record<string, unknown>; } catch { /* keep {} */ }
    return {
        id: r.id, name: r.name, avatar: r.avatar, color: r.color, kind: r.kind === "kid" ? "kid" : "adult",
        maxAge: r.max_age, hasPin: Boolean(r.pin_hash), prefs, sort: r.sort, createdAt: r.created_at, updatedAt: r.updated_at,
    };
};

export function hashPin(pin: string, salt = crypto.randomBytes(16)): string {
    const key = crypto.scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 });
    return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
    const [algo, saltB64, keyB64] = stored.split("$");
    if (algo !== "scrypt" || !saltB64 || !keyB64) return false;
    const expected = Buffer.from(keyB64, "base64");
    const got = crypto.scryptSync(pin, Buffer.from(saltB64, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(expected, got);
}

export const isValidPin = (pin: unknown): pin is string => typeof pin === "string" && /^\d{4}$/.test(pin);

export interface ProfileInput {
    name?: string;
    avatar?: string | null;
    color?: string | null;
    kind?: ProfileKind;
    maxAge?: number | null;
    /** 4 digits to set, `null` to clear, undefined = unchanged. */
    pin?: string | null;
    prefs?: Record<string, unknown>;
    sort?: number;
}

export type UnlockResult =
    | { ok: true; token: string; expiresAt: number }
    | { ok: false; reason: "not_found" | "wrong_pin" | "locked"; retryAfterMs?: number; triesLeft?: number };

export class ProfileStore {
    private readonly tries = new Map<string, { count: number; lockedUntil: number }>();

    constructor(private readonly db: MediaDb, private readonly now: () => number = Date.now) {
        this.ensureDefault();
    }

    /** One profile always exists (`default`, adult, no PIN) so legacy clients keep working. */
    private ensureDefault(): void {
        const n = (this.db.prepare("SELECT COUNT(*) AS n FROM profiles").get() as { n: number }).n;
        if (n > 0) return;
        const t = this.now();
        this.db.prepare(
            "INSERT INTO profiles (id, name, avatar, color, kind, max_age, pin_hash, prefs, sort, created_at, updated_at) VALUES ('default', ?, NULL, NULL, 'adult', NULL, NULL, '{}', 0, ?, ?)",
        ).run("Principal", t, t);
    }

    list(): Profile[] {
        return (this.db.prepare("SELECT * FROM profiles ORDER BY sort, created_at").all() as Row[]).map(toProfile);
    }

    get(id: string): Profile | null {
        const r = this.db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as Row | undefined;
        return r ? toProfile(r) : null;
    }

    /** Unknown ids (legacy opaque strings such as a userId) resolve to no restriction. */
    maxAgeOf(id: string): number | null {
        return this.get(id)?.maxAge ?? null;
    }

    create(input: ProfileInput): Profile {
        const name = (input.name ?? "").trim().slice(0, 40);
        if (!name) throw new ProfileError("name required");
        if (this.list().length >= MAX_PROFILES) throw new ProfileError(`at most ${MAX_PROFILES} profiles`);
        const id = `p_${crypto.randomBytes(6).toString("base64url")}`;
        const kind: ProfileKind = input.kind === "kid" ? "kid" : "adult";
        const maxAge = normaliseMaxAge(input.maxAge, kind);
        if (input.pin !== undefined && input.pin !== null && !isValidPin(input.pin)) throw new ProfileError("pin must be 4 digits");
        const t = this.now();
        const sort = input.sort ?? this.list().length;
        this.db.prepare(
            "INSERT INTO profiles (id, name, avatar, color, kind, max_age, pin_hash, prefs, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(id, name, input.avatar ?? null, input.color ?? null, kind, maxAge, input.pin ? hashPin(input.pin) : null,
            JSON.stringify(input.prefs ?? {}), sort, t, t);
        this.bump();
        return this.get(id)!;
    }

    update(id: string, input: ProfileInput): Profile | null {
        const cur = this.db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as Row | undefined;
        if (!cur) return null;
        const name = input.name !== undefined ? input.name.trim().slice(0, 40) : cur.name;
        if (!name) throw new ProfileError("name required");
        const kind: ProfileKind = input.kind ?? cur.kind;
        const maxAge = input.maxAge !== undefined || input.kind !== undefined
            ? normaliseMaxAge(input.maxAge !== undefined ? input.maxAge : cur.max_age, kind)
            : cur.max_age;
        let pinHash = cur.pin_hash;
        if (input.pin === null) pinHash = null;
        else if (input.pin !== undefined) {
            if (!isValidPin(input.pin)) throw new ProfileError("pin must be 4 digits");
            pinHash = hashPin(input.pin);
        }
        const prefs = input.prefs !== undefined ? JSON.stringify({ ...safeJson(cur.prefs), ...input.prefs }) : cur.prefs;
        this.db.prepare(
            "UPDATE profiles SET name = ?, avatar = ?, color = ?, kind = ?, max_age = ?, pin_hash = ?, prefs = ?, sort = ?, updated_at = ? WHERE id = ?",
        ).run(name, input.avatar !== undefined ? input.avatar : cur.avatar, input.color !== undefined ? input.color : cur.color,
            kind, maxAge, pinHash, prefs, input.sort ?? cur.sort, this.now(), id);
        this.bump();
        return this.get(id);
    }

    remove(id: string): boolean {
        if (this.list().length <= 1) throw new ProfileError("cannot delete the last profile");
        const r = this.db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
        if (r.changes > 0) {
            this.db.prepare("DELETE FROM watchlist WHERE profile_id = ?").run(id);
            this.bump();
        }
        return r.changes > 0;
    }

    unlock(id: string, pin: unknown): UnlockResult {
        const row = this.db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as Row | undefined;
        if (!row) return { ok: false, reason: "not_found" };
        const t = this.now();
        const state = this.tries.get(id) ?? { count: 0, lockedUntil: 0 };
        if (state.lockedUntil > t) return { ok: false, reason: "locked", retryAfterMs: state.lockedUntil - t };
        if (row.pin_hash) {
            if (!isValidPin(pin) || !verifyPin(pin, row.pin_hash)) {
                state.count += 1;
                if (state.count >= PIN_MAX_TRIES) { state.lockedUntil = t + PIN_LOCK_MS; state.count = 0; }
                this.tries.set(id, state);
                return state.lockedUntil > t
                    ? { ok: false, reason: "locked", retryAfterMs: state.lockedUntil - t }
                    : { ok: false, reason: "wrong_pin", triesLeft: PIN_MAX_TRIES - state.count };
            }
        }
        this.tries.delete(id);
        const expiresAt = t + PROFILE_TOKEN_TTL_MS;
        return { ok: true, token: this.signToken(id, expiresAt), expiresAt };
    }

    /** Returns the profile id when the token is valid and unexpired. */
    verifyToken(token: string | undefined | null): string | null {
        if (!token) return null;
        const [id, expStr, mac] = token.split(".");
        if (!id || !expStr || !mac) return null;
        const exp = Number(expStr);
        if (!Number.isFinite(exp) || exp < this.now()) return null;
        const expected = this.mac(`${id}.${exp}`);
        const a = Buffer.from(mac);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
        return this.get(id) ? id : null;
    }

    getRevision(): number {
        return Number(getMeta(this.db, "profiles_rev") ?? "0");
    }

    private bump(): void {
        setMeta(this.db, "profiles_rev", String(this.getRevision() + 1));
    }

    private secret(): string {
        let s = getMeta(this.db, "profile_token_secret");
        if (!s) {
            s = crypto.randomBytes(32).toString("base64url");
            setMeta(this.db, "profile_token_secret", s);
        }
        return s;
    }

    private mac(payload: string): string {
        return crypto.createHmac("sha256", this.secret()).update(payload).digest("base64url");
    }

    private signToken(id: string, exp: number): string {
        return `${id}.${exp}.${this.mac(`${id}.${exp}`)}`;
    }
}

export class ProfileError extends Error {}

function safeJson(s: string): Record<string, unknown> {
    try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

function normaliseMaxAge(v: number | null | undefined, kind: ProfileKind): number | null {
    if (v === null || v === undefined) return kind === "kid" ? KID_DEFAULT_MAX_AGE : null;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 0 || n > 18) throw new ProfileError("maxAge must be 0..18 or null");
    return n;
}
