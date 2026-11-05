/**
 * Watch Together chat moderation (WP16-50, App Store 1.2 / Play UGC policy):
 *   - word filter (RO + EN, accent-insensitive) masking abuse with `***`, owner can turn it off;
 *   - reports of single messages → `chat_reports` (owner lists/resolves via `/hub/reports`);
 *   - per-profile blocks of device ids → `hub_blocks` (applied by HubCore when relaying chat/reactions).
 */

import crypto from "node:crypto";
import type { MediaDb } from "../media/db";
import { getMeta, setMeta } from "../media/db";
import { foldText } from "../lib/fold";
import { STEMS, WORDS } from "./chat-wordlist";

export const REPORT_REASONS = ["spam", "harassment", "hate", "sexual", "violence", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface ChatReport {
    id: string;
    roomId: string;
    messageId: string;
    reporterDeviceId: string;
    reporterName: string;
    offenderDeviceId: string | null;
    offenderName: string | null;
    text: string | null;
    reason: ReportReason;
    createdAt: number;
    resolvedAt: number | null;
    resolution: string | null;
}

export interface HubBlock { profileId: string; deviceId: string; name: string | null; createdAt: number }

/** What HubCore needs; `MediaModerationStore` is the SQLite implementation. */
export interface ModerationStore {
    chatFilterEnabled(): boolean;
    addReport(r: Omit<ChatReport, "id" | "createdAt" | "resolvedAt" | "resolution">): ChatReport;
    addBlock(profileId: string, deviceId: string, name: string | null): void;
    removeBlock(profileId: string, deviceId: string): boolean;
    blockedDeviceIds(profileId: string): Set<string>;
}

const STEM_RE = new RegExp(`^(?:${STEMS.map(escapeRe).join("|")})`);
const WORD_SET = new Set(WORDS);

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when a single word (any case/diacritics) is on the list. Repeated letters are collapsed ("fuuuck"). */
export function isBlockedWord(word: string): boolean {
    const f = foldText(word).replace(/[^a-z0-9]/g, "");
    if (!f) return false;
    const squeezed = f.replace(/(.)\1+/g, "$1");
    return WORD_SET.has(f) || WORD_SET.has(squeezed) || STEM_RE.test(f) || STEM_RE.test(squeezed);
}

/** Masks every listed word with `***`. Returns the text unchanged when nothing matched. */
export function maskProfanity(text: string): { text: string; masked: boolean } {
    let masked = false;
    // Words = runs of letters/digits (Unicode), so punctuation and emoji survive untouched.
    const out = text.replace(/[\p{L}\p{N}]+/gu, (w) => {
        if (!isBlockedWord(w)) return w;
        masked = true;
        return "***";
    });
    return { text: masked ? out : text, masked };
}

type ReportRow = {
    id: string; room_id: string; message_id: string; reporter_device_id: string; reporter_name: string;
    offender_device_id: string | null; offender_name: string | null; text: string | null; reason: string;
    created_at: number; resolved_at: number | null; resolution: string | null;
};

const toReport = (r: ReportRow): ChatReport => ({
    id: r.id, roomId: r.room_id, messageId: r.message_id, reporterDeviceId: r.reporter_device_id, reporterName: r.reporter_name,
    offenderDeviceId: r.offender_device_id, offenderName: r.offender_name, text: r.text,
    reason: (REPORT_REASONS as readonly string[]).includes(r.reason) ? r.reason as ReportReason : "other",
    createdAt: r.created_at, resolvedAt: r.resolved_at, resolution: r.resolution,
});

export class MediaModerationStore implements ModerationStore {
    constructor(private readonly db: MediaDb, private readonly now: () => number = Date.now) {}

    chatFilterEnabled(): boolean {
        return getMeta(this.db, "hub_chat_filter") !== "0";
    }

    setChatFilter(enabled: boolean): void {
        setMeta(this.db, "hub_chat_filter", enabled ? "1" : "0");
    }

    addReport(r: Omit<ChatReport, "id" | "createdAt" | "resolvedAt" | "resolution">): ChatReport {
        const id = `rep_${crypto.randomBytes(8).toString("base64url")}`;
        const t = this.now();
        this.db.prepare(
            `INSERT INTO chat_reports (id, room_id, message_id, reporter_device_id, reporter_name, offender_device_id, offender_name, text, reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, r.roomId, r.messageId, r.reporterDeviceId, r.reporterName, r.offenderDeviceId, r.offenderName, r.text, r.reason, t);
        return this.getReport(id)!;
    }

    getReport(id: string): ChatReport | null {
        const row = this.db.prepare("SELECT * FROM chat_reports WHERE id = ?").get(id) as ReportRow | undefined;
        return row ? toReport(row) : null;
    }

    listReports(opts: { status?: "open" | "resolved" | "all"; limit?: number } = {}): ChatReport[] {
        const where = opts.status === "resolved" ? "WHERE resolved_at IS NOT NULL" : opts.status === "all" ? "" : "WHERE resolved_at IS NULL";
        const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
        return (this.db.prepare(`SELECT * FROM chat_reports ${where} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`).all() as ReportRow[]).map(toReport);
    }

    resolveReport(id: string, resolution: string): ChatReport | null {
        const r = this.db.prepare("UPDATE chat_reports SET resolved_at = ?, resolution = ? WHERE id = ?").run(this.now(), resolution.slice(0, 200) || "resolved", id);
        return r.changes > 0 ? this.getReport(id) : null;
    }

    addBlock(profileId: string, deviceId: string, name: string | null): void {
        this.db.prepare(
            `INSERT INTO hub_blocks (profile_id, blocked_device_id, blocked_name, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(profile_id, blocked_device_id) DO UPDATE SET blocked_name = excluded.blocked_name`,
        ).run(profileId, deviceId, name, this.now());
    }

    removeBlock(profileId: string, deviceId: string): boolean {
        return this.db.prepare("DELETE FROM hub_blocks WHERE profile_id = ? AND blocked_device_id = ?").run(profileId, deviceId).changes > 0;
    }

    blockedDeviceIds(profileId: string): Set<string> {
        const rows = this.db.prepare("SELECT blocked_device_id FROM hub_blocks WHERE profile_id = ?").all(profileId) as { blocked_device_id: string }[];
        return new Set(rows.map((r) => r.blocked_device_id));
    }

    listBlocks(profileId?: string): HubBlock[] {
        const rows = (profileId
            ? this.db.prepare("SELECT * FROM hub_blocks WHERE profile_id = ? ORDER BY created_at DESC").all(profileId)
            : this.db.prepare("SELECT * FROM hub_blocks ORDER BY created_at DESC").all()) as
            { profile_id: string; blocked_device_id: string; blocked_name: string | null; created_at: number }[];
        return rows.map((r) => ({ profileId: r.profile_id, deviceId: r.blocked_device_id, name: r.blocked_name, createdAt: r.created_at }));
    }
}
