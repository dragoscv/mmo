/**
 * DvrScheduler — one-off and series recordings of live channels.
 *
 * - Video/audio are NEVER re-encoded: capture is `-c copy -map 0 -f mpegts`,
 *   the finished `.ts` is remuxed to `.mkv` with `-c copy` inside the global
 *   analysis slot at IDLE priority.
 * - Each source has a tuner limit (HDHomeRun TunerCount, Xtream
 *   max_connections, M3U default 2). Over-subscribed recordings are flagged
 *   `conflict: true` (first scheduled wins) and fail loudly at start time
 *   instead of being dropped silently.
 * - Series rules are expanded against the guide after every guide refresh.
 * - On restart: in-progress → failed, past scheduled → failed (with reason).
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { FFMPEG_BIN } from "../library/ffmpeg-paths";
import { killTree, lowerPriority, withAnalysisSlot } from "../library/ffmpeg-jobs";
import type { LiveTvDb } from "./db";
import type { LiveTvService } from "./service";
import { safeFileName } from "./service";
import { LiveTvError, type RecordingInput, type RecordingStatus, type RecordingView, type RuleInput, type RuleView } from "./types";
import { errorMessage, newId, redactText, silentLogger, type LiveTvLogger } from "./util";

export interface FfmpegProcess {
    pid?: number;
    kill(): void;
    done: Promise<{ code: number | null; stderr: string }>;
}

export type SpawnFfmpeg = (args: string[], opts: { purpose: "record" | "remux" }) => FfmpegProcess;

export const defaultSpawnFfmpeg: SpawnFfmpeg = (args, opts) => {
    const child = spawn(FFMPEG_BIN, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    lowerPriority(child.pid, opts.purpose === "remux" ? "idle" : "below-normal");
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => { stderr = (stderr + b.toString("utf8")).slice(-16_000); });
    const done = new Promise<{ code: number | null; stderr: string }>((resolve) => {
        child.on("error", (err) => resolve({ code: -1, stderr: `${stderr}${errorMessage(err)}` }));
        child.on("close", (code) => resolve({ code, stderr }));
    });
    return { pid: child.pid, kill: () => killTree(child.pid), done };
};

export interface DvrOptions {
    db: LiveTvDb;
    service: LiveTvService;
    recordingsDir: string;
    log?: LiveTvLogger;
    spawnFfmpeg?: SpawnFfmpeg;
    now?: () => number;
    /** Scheduler tick (default 5 s). */
    tickMs?: number;
    /** Called once a recording ends as `done` or `failed` (push relay, WP16-50). Never throws into the DVR. */
    onFinished?: (r: { id: string; title: string; channelId: string; status: "done" | "failed"; error: string | null }) => void;
}

interface RecRow {
    id: string; channel_id: string; title: string; start: number; stop: number; padding_before_sec: number; padding_after_sec: number;
    status: RecordingStatus; path: string | null; error: string | null; rule_id: string | null; created_at: number;
}

interface RuleRow {
    id: string; title_match: string; channel_id: string | null; padding_before_sec: number; padding_after_sec: number;
    keep_last: number; enabled: number; created_at: number;
}

interface Active { proc: FfmpegProcess; cancelled: boolean; finished: Promise<void> }

const effStart = (r: RecRow) => r.start - r.padding_before_sec * 1000;
const effStop = (r: RecRow) => r.stop + r.padding_after_sec * 1000;
const MAX_RECORDING_MS = 24 * 3_600_000;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** Pure: ffmpeg args for a live capture. Always stream copy. */
export function recordArgs(url: string, seconds: number, outTs: string): string[] {
    return [
        "-hide_banner", "-loglevel", "error", "-y",
        ...(/^https?:\/\//i.test(url) ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10"] : []),
        "-i", url,
        "-map", "0", "-c", "copy",
        "-t", String(Math.max(1, Math.ceil(seconds))),
        "-f", "mpegts", outTs,
    ];
}

/** Pure: ffmpeg args for the `.ts` → `.mkv` remux. Always stream copy. */
export function remuxArgs(inTs: string, outMkv: string): string[] {
    return ["-hide_banner", "-loglevel", "error", "-y", "-i", inTs, "-map", "0", "-c", "copy", outMkv];
}

function validPadding(v: unknown, name: string): number | undefined {
    if (v === undefined) return undefined;
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 3600) throw new LiveTvError(400, `${name} must be 0..3600 seconds`);
    return v as number;
}

export class DvrScheduler {
    private readonly db: LiveTvDb;
    private readonly service: LiveTvService;
    private readonly dir: string;
    private readonly log: LiveTvLogger;
    private readonly spawnFfmpeg: SpawnFfmpeg;
    private readonly now: () => number;
    private readonly tickMs: number;
    private timer: NodeJS.Timeout | null = null;
    private readonly active = new Map<string, Active>();
    private readonly onFinished: DvrOptions["onFinished"];

    constructor(opts: DvrOptions) {
        this.onFinished = opts.onFinished;
        this.db = opts.db;
        this.service = opts.service;
        this.dir = opts.recordingsDir;
        this.log = opts.log ?? silentLogger;
        this.spawnFfmpeg = opts.spawnFfmpeg ?? defaultSpawnFfmpeg;
        this.now = opts.now ?? Date.now;
        this.tickMs = opts.tickMs ?? 5_000;
        this.service.onGuideRefreshed(() => {
            try { this.expandRules(); } catch (err) { this.log.warn("[livetv] rule expansion failed", {}, err); }
        });
    }

    // ── lifecycle ────────────────────────────────────────────────────────

    /** Mark recordings interrupted by a restart, then start the tick loop. */
    start(): void {
        this.recover();
        if (this.timer) return;
        this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
        this.timer.unref?.();
    }

    recover(): { interrupted: number; missed: number } {
        const now = this.now();
        const interrupted = this.db.prepare(
            "UPDATE recordings SET status = 'failed', error = 'server restarted during recording' WHERE status = 'recording'",
        ).run().changes;
        const scheduled = this.db.prepare("SELECT * FROM recordings WHERE status = 'scheduled'").all() as RecRow[];
        let missed = 0;
        for (const r of scheduled) {
            if (effStop(r) <= now) {
                this.setStatus(r.id, "failed", { error: "missed: server was not running at the scheduled time" });
                missed++;
            }
        }
        if (interrupted || missed) this.log.warn("[livetv] DVR recovery", { interrupted, missed });
        return { interrupted, missed };
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        for (const [id, a] of this.active) {
            a.cancelled = true;
            a.proc.kill();
            this.setStatus(id, "failed", { error: "server stopped during recording" });
        }
        this.active.clear();
    }

    /** Resolves when every running capture/remux has finished (tests). */
    async idle(): Promise<void> {
        while (this.active.size) await Promise.all([...this.active.values()].map((a) => a.finished));
    }

    // ── recordings ───────────────────────────────────────────────────────

    private rec(id: string): RecRow | undefined {
        return this.db.prepare("SELECT * FROM recordings WHERE id = ?").get(id) as RecRow | undefined;
    }

    private setStatus(id: string, status: RecordingStatus, extra: { path?: string | null; error?: string | null } = {}): void {
        const r = this.rec(id);
        if (!r) return;
        this.db.prepare("UPDATE recordings SET status = ?, path = ?, error = ? WHERE id = ?").run(
            status, extra.path !== undefined ? extra.path : r.path, extra.error !== undefined ? extra.error : r.error, id,
        );
        if ((status === "done" || status === "failed") && r.status !== status && this.onFinished) {
            try {
                this.onFinished({ id, title: r.title, channelId: r.channel_id, status, error: extra.error !== undefined ? extra.error : r.error });
            } catch { /* best-effort */ }
        }
    }

    /** Ids of scheduled/recording entries that do not fit their source's tuner limit (first created wins). */
    conflicts(): Set<string> {
        const rows = this.db.prepare(
            "SELECT * FROM recordings WHERE status IN ('scheduled','recording') ORDER BY (status = 'recording') DESC, created_at, start, rowid",
        ).all() as RecRow[];
        const bySource = new Map<string, RecRow[]>();
        for (const r of rows) {
            const sid = this.service.channelSourceId(r.channel_id) ?? "?";
            const arr = bySource.get(sid);
            if (arr) arr.push(r); else bySource.set(sid, [r]);
        }
        const out = new Set<string>();
        for (const [sid, list] of bySource) {
            const limit = this.service.tunerLimit(sid);
            const accepted: RecRow[] = [];
            for (const r of list) {
                const s = effStart(r);
                const e = effStop(r);
                const overlapping = accepted.filter((a) => effStart(a) < e && effStop(a) > s);
                // Peak concurrency inside [s, e) happens at s or at an overlapping start.
                const points = [s, ...overlapping.map(effStart).filter((p) => p > s && p < e)];
                const peak = Math.max(0, ...points.map((p) => overlapping.filter((a) => effStart(a) <= p && effStop(a) > p).length));
                if (peak + 1 > limit) out.add(r.id);
                else accepted.push(r);
            }
        }
        return out;
    }

    private view(r: RecRow, conflicts: Set<string>): RecordingView {
        return {
            id: r.id, channelId: r.channel_id, channelName: this.service.channelName(r.channel_id), title: r.title, start: r.start, stop: r.stop,
            paddingBeforeSec: r.padding_before_sec, paddingAfterSec: r.padding_after_sec, status: r.status, path: r.path, error: r.error,
            ruleId: r.rule_id, createdAt: r.created_at, conflict: conflicts.has(r.id),
        };
    }

    list(): RecordingView[] {
        const conflicts = this.conflicts();
        return (this.db.prepare("SELECT * FROM recordings ORDER BY start DESC").all() as RecRow[]).map((r) => this.view(r, conflicts));
    }

    get(id: string): RecordingView | null {
        const r = this.rec(id);
        return r ? this.view(r, this.conflicts()) : null;
    }

    schedule(input: RecordingInput & { ruleId?: string | null }): RecordingView {
        if (typeof input.channelId !== "string" || !input.channelId) throw new LiveTvError(400, "channelId required");
        if (!Number.isFinite(input.start) || !Number.isFinite(input.stop) || input.stop <= input.start) throw new LiveTvError(400, "start/stop must be epoch ms with stop > start");
        if (input.stop - input.start > MAX_RECORDING_MS) throw new LiveTvError(400, "recordings are limited to 24 h");
        if (input.title !== undefined && (typeof input.title !== "string" || input.title.length > 300)) throw new LiveTvError(400, "title must be a string (max 300)");
        const before = validPadding(input.paddingBeforeSec, "paddingBeforeSec") ?? 0;
        const after = validPadding(input.paddingAfterSec, "paddingAfterSec") ?? 0;
        if (input.stop + after * 1000 <= this.now()) throw new LiveTvError(400, "recording would end in the past");
        const name = this.service.channelName(input.channelId);
        if (name === null) throw new LiveTvError(404, "channel not found");
        const id = newId();
        this.db.prepare(
            `INSERT INTO recordings (id, channel_id, title, start, stop, padding_before_sec, padding_after_sec, status, rule_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
        ).run(id, input.channelId, input.title?.trim() || name, input.start, input.stop, before, after, input.ruleId ?? null, this.now());
        const view = this.get(id)!;
        if (view.conflict) this.log.warn("[livetv] recording conflicts with the tuner limit", { id, channel: input.channelId });
        return view;
    }

    /** Schedule from a guide entry (channelId + programme start). */
    scheduleProgramme(channelId: string, start: number, padding: { before?: number; after?: number } = {}): RecordingView {
        const p = this.service.programmeAt(channelId, start);
        if (!p) throw new LiveTvError(404, "programme not found in the guide");
        return this.schedule({
            channelId, start: p.start, stop: p.stop, title: p.subtitle ? `${p.title} - ${p.subtitle}` : p.title,
            paddingBeforeSec: padding.before, paddingAfterSec: padding.after,
        });
    }

    /** Cancel a scheduled/running recording, or delete a finished one (row + file). */
    remove(id: string): { status: RecordingStatus; deleted: boolean } {
        const r = this.rec(id);
        if (!r) throw new LiveTvError(404, "recording not found");
        if (r.status === "scheduled") {
            this.setStatus(id, "cancelled");
            return { status: "cancelled", deleted: false };
        }
        if (r.status === "recording") {
            const a = this.active.get(id);
            if (a) { a.cancelled = true; a.proc.kill(); }
            this.setStatus(id, "cancelled", { error: "cancelled by user" });
            return { status: "cancelled", deleted: false };
        }
        this.deleteFile(r.path);
        this.db.prepare("DELETE FROM recordings WHERE id = ?").run(id);
        return { status: r.status, deleted: true };
    }

    /**
     * Absolute path of a finished recording's file for playback, or null (not done, missing, or outside the
     * recordings directory — the DB path is never trusted blindly).
     */
    filePath(id: string): string | null {
        const r = this.rec(id);
        if (!r || r.status !== "done" || !r.path) return null;
        const resolved = path.resolve(r.path);
        if (!resolved.startsWith(path.resolve(this.dir) + path.sep)) return null;
        return fs.existsSync(resolved) ? resolved : null;
    }

    private deleteFile(p: string | null): void {
        if (!p) return;
        const resolved = path.resolve(p);
        // Only ever delete inside the recordings directory.
        if (!resolved.startsWith(path.resolve(this.dir) + path.sep)) return;
        try { fs.rmSync(resolved, { force: true }); } catch (err) { this.log.warn("[livetv] could not delete recording file", { path: resolved }, err); }
    }

    // ── scheduler tick ───────────────────────────────────────────────────

    async tick(): Promise<void> {
        const now = this.now();
        const due = this.db.prepare(
            "SELECT * FROM recordings WHERE status = 'scheduled' ORDER BY created_at, rowid",
        ).all() as RecRow[];
        for (const r of due) {
            if (effStart(r) > now) continue;
            if (effStop(r) <= now) {
                this.setStatus(r.id, "failed", { error: "missed: start time passed" });
                continue;
            }
            const sourceId = this.service.channelSourceId(r.channel_id);
            const url = this.service.streamUrlFor(r.channel_id);
            if (!sourceId || !url) {
                this.setStatus(r.id, "failed", { error: "channel no longer exists" });
                continue;
            }
            const busy = (this.db.prepare(
                "SELECT COUNT(*) AS n FROM recordings r JOIN channels c ON c.id = r.channel_id WHERE r.status = 'recording' AND c.source_id = ?",
            ).get(sourceId) as { n: number }).n;
            if (busy >= this.service.tunerLimit(sourceId)) {
                this.setStatus(r.id, "failed", { error: `tuner conflict: all ${this.service.tunerLimit(sourceId)} tuner(s) of this source are busy` });
                continue;
            }
            this.begin(r, url, (effStop(r) - now) / 1000);
        }
    }

    private begin(r: RecRow, url: string, seconds: number): void {
        const tmpDir = path.join(this.dir, ".partial");
        fs.mkdirSync(tmpDir, { recursive: true });
        const tmp = path.join(tmpDir, `${r.id}.ts`);
        let proc: FfmpegProcess;
        try {
            proc = this.spawnFfmpeg(recordArgs(url, seconds, tmp), { purpose: "record" });
        } catch (err) {
            this.setStatus(r.id, "failed", { error: `could not start ffmpeg: ${errorMessage(err)}` });
            return;
        }
        this.setStatus(r.id, "recording", { path: tmp, error: null });
        this.log.info("[livetv] recording started", { id: r.id, channel: r.channel_id, seconds: Math.round(seconds) });
        const entry: Active = { proc, cancelled: false, finished: Promise.resolve() };
        entry.finished = proc.done
            .then((res) => this.finish(r.id, tmp, res, entry))
            .catch((err: unknown) => { this.setStatus(r.id, "failed", { error: errorMessage(err) }); })
            .finally(() => { this.active.delete(r.id); });
        this.active.set(r.id, entry);
    }

    private finalPath(r: RecRow): string {
        const d = new Date(r.start);
        const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}${pad2(d.getMinutes())}`;
        const channel = safeFileName(this.service.channelName(r.channel_id) ?? "channel", 40);
        return path.join(this.dir, `${safeFileName(r.title)} - ${channel} - ${stamp} [${r.id.slice(0, 8)}].mkv`);
    }

    private async finish(id: string, tmp: string, res: { code: number | null; stderr: string }, entry: Active): Promise<void> {
        const r = this.rec(id);
        if (!r) return;
        const secrets = [this.service.streamUrlFor(r.channel_id)];
        const size = (() => { try { return fs.statSync(tmp).size; } catch { return 0; } })();
        if (entry.cancelled) {
            if (r.status === "cancelled") this.deleteFile(tmp);
            return;
        }
        if (size === 0) {
            const why = redactText(res.stderr.trim().split(/\r?\n/).slice(-3).join(" ") || `ffmpeg exited with code ${res.code}`, secrets);
            this.deleteFile(tmp);
            this.setStatus(id, "failed", { path: null, error: why });
            this.log.warn("[livetv] recording failed", { id, error: why });
            return;
        }
        const note = res.code === 0 ? null : `stream ended early (ffmpeg code ${res.code})`;
        const out = this.finalPath(r);
        let remux: { code: number | null; stderr: string };
        try {
            remux = await withAnalysisSlot(() => this.spawnFfmpeg(remuxArgs(tmp, out), { purpose: "remux" }).done);
        } catch (err) {
            remux = { code: -1, stderr: errorMessage(err) };
        }
        if (remux.code === 0) {
            this.deleteFile(tmp);
            this.setStatus(id, "done", { path: out, error: note });
        } else {
            // Keep the playable .ts rather than lose the recording.
            const kept = path.join(this.dir, path.basename(out, ".mkv") + ".ts");
            try { fs.renameSync(tmp, kept); } catch { /* keep tmp path */ }
            this.setStatus(id, "done", { path: fs.existsSync(kept) ? kept : tmp, error: `remux to mkv failed; kept .ts${note ? `; ${note}` : ""}` });
        }
        this.log.info("[livetv] recording finished", { id });
        if (r.rule_id) this.prune(r.rule_id);
    }

    /** keep_last per rule: delete the oldest finished recordings beyond the limit. */
    prune(ruleId: string): number {
        const rule = this.db.prepare("SELECT * FROM rules WHERE id = ?").get(ruleId) as RuleRow | undefined;
        if (!rule || rule.keep_last <= 0) return 0;
        const done = this.db.prepare("SELECT * FROM recordings WHERE rule_id = ? AND status = 'done' ORDER BY start DESC").all(ruleId) as RecRow[];
        const extra = done.slice(rule.keep_last);
        for (const r of extra) {
            this.deleteFile(r.path);
            this.db.prepare("DELETE FROM recordings WHERE id = ?").run(r.id);
        }
        return extra.length;
    }

    // ── series rules ─────────────────────────────────────────────────────

    private ruleView(r: RuleRow): RuleView {
        return {
            id: r.id, titleMatch: r.title_match, channelId: r.channel_id, paddingBeforeSec: r.padding_before_sec,
            paddingAfterSec: r.padding_after_sec, keepLast: r.keep_last, enabled: r.enabled === 1, createdAt: r.created_at,
        };
    }

    listRules(): RuleView[] {
        return (this.db.prepare("SELECT * FROM rules ORDER BY created_at").all() as RuleRow[]).map((r) => this.ruleView(r));
    }

    createRule(input: RuleInput): RuleView {
        if (typeof input.titleMatch !== "string" || input.titleMatch.trim().length < 2 || input.titleMatch.length > 200) {
            throw new LiveTvError(400, "titleMatch required (2..200 chars)");
        }
        if (input.channelId !== undefined && input.channelId !== null) {
            if (typeof input.channelId !== "string" || this.service.channelName(input.channelId) === null) throw new LiveTvError(400, "unknown channelId");
        }
        if (input.keepLast !== undefined && (!Number.isInteger(input.keepLast) || input.keepLast < 0 || input.keepLast > 1000)) throw new LiveTvError(400, "keepLast must be 0..1000");
        if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new LiveTvError(400, "enabled must be boolean");
        const before = validPadding(input.paddingBeforeSec, "paddingBeforeSec") ?? 60;
        const after = validPadding(input.paddingAfterSec, "paddingAfterSec") ?? 300;
        const id = newId();
        this.db.prepare(
            `INSERT INTO rules (id, title_match, channel_id, padding_before_sec, padding_after_sec, keep_last, enabled, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, input.titleMatch.trim(), input.channelId ?? null, before, after, input.keepLast ?? 0, input.enabled === false ? 0 : 1, this.now());
        this.expandRules();
        return this.ruleView(this.db.prepare("SELECT * FROM rules WHERE id = ?").get(id) as RuleRow);
    }

    deleteRule(id: string): boolean {
        const exists = this.db.prepare("SELECT 1 FROM rules WHERE id = ?").get(id);
        if (!exists) throw new LiveTvError(404, "rule not found");
        this.db.transaction(() => {
            this.db.prepare("DELETE FROM recordings WHERE rule_id = ? AND status = 'scheduled'").run(id);
            this.db.prepare("DELETE FROM rules WHERE id = ?").run(id);
        })();
        return true;
    }

    /** Create scheduled recordings for every upcoming programme a rule matches. Idempotent. */
    expandRules(): number {
        const rules = this.db.prepare("SELECT * FROM rules WHERE enabled = 1").all() as RuleRow[];
        if (!rules.length) return 0;
        const now = this.now();
        const exists = this.db.prepare("SELECT 1 FROM recordings WHERE channel_id = ? AND start = ?");
        const existsTitle = this.db.prepare("SELECT 1 FROM recordings WHERE rule_id = ? AND start = ? AND lower(title) = lower(?)");
        let created = 0;
        for (const rule of rules) {
            const needle = rule.title_match.toLowerCase();
            for (const p of this.service.upcoming(now, rule.channel_id)) {
                if (!p.title.toLowerCase().includes(needle)) continue;
                if (exists.get(p.channelId, p.start)) continue;
                const title = p.subtitle ? `${p.title} - ${p.subtitle}` : p.title;
                // Without a channel filter the same airing on several channels is recorded once.
                if (existsTitle.get(rule.id, p.start, title)) continue;
                try {
                    this.schedule({
                        channelId: p.channelId, start: p.start, stop: p.stop, title,
                        paddingBeforeSec: rule.padding_before_sec, paddingAfterSec: rule.padding_after_sec, ruleId: rule.id,
                    });
                    created++;
                } catch (err) {
                    this.log.warn("[livetv] rule could not schedule", { rule: rule.id, error: errorMessage(err) });
                }
            }
        }
        return created;
    }
}
