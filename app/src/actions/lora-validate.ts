/**
 * LoRA training corpus validator — server actions.
 *
 * Pages: /lora/validate (drag-drop, paste folder path, or pick demo).
 * Calls the existing CLI at scripts/validate-lora-corpus.mjs which uses
 * ffprobe (must be on PATH).
 */
"use server";

import "server-only";

import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { auth } from "@/auth";

const WORKSPACE_ROOT = path.resolve(process.cwd(), "..");
const CLI_PATH = path.join(WORKSPACE_ROOT, "app", "scripts", "validate-lora-corpus.mjs");

export interface ValidateClipResult {
    file: string;
    ok: boolean;
    durationSec?: number;
    sampleRate?: number;
    channels?: number;
    hasLyrics?: boolean;
    issues: string[];
}

export interface ValidateCorpusReport {
    ok: boolean;
    clipCount: number;
    totalDurationSec: number;
    issuesByFile: Record<string, string[]>;
    verdict: "ready-to-train" | "minimal-corpus" | "insufficient" | "error";
    summary: string;
    clips: ValidateClipResult[];
    error?: string;
}

async function uid(): Promise<string> {
    const session = await auth();
    const id = session?.user?.id;
    if (!id) throw new Error("Not signed in.");
    return id;
}

/** Validate a directory by absolute path on the server. */
export async function validateLoraCorpusByPath(dir: string): Promise<ValidateCorpusReport> {
    await uid();
    try {
        await fsp.access(dir);
    } catch {
        return makeError(`dir-not-found: ${dir}`);
    }
    return runCli(dir);
}

/** Validate an uploaded set of files. Caller (the page) sends a FormData
 *  with multiple `file` entries; we stage them in tmp and call the CLI. */
export async function validateLoraCorpusFromFormData(form: FormData): Promise<ValidateCorpusReport> {
    const userId = await uid();
    const files = form.getAll("file") as File[];
    if (files.length === 0) return makeError("no-files");

    const stageDir = path.join(tmpdir(), `lora-validate-${userId}-${Date.now()}`);
    await fsp.mkdir(stageDir, { recursive: true });

    try {
        for (const f of files) {
            // Allow only audio extensions + optional .txt sidecars.
            const ext = path.extname(f.name).toLowerCase();
            if (![".wav", ".flac", ".mp3", ".ogg", ".opus", ".m4a", ".txt"].includes(ext)) continue;
            const safe = f.name.replace(/[^A-Za-z0-9_.-]/g, "_");
            const buf = Buffer.from(await f.arrayBuffer());
            await fsp.writeFile(path.join(stageDir, safe), buf);
        }
        return await runCli(stageDir);
    } finally {
        // Best-effort cleanup (don't await; tmp will get GC'd anyway).
        fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }
}

function makeError(error: string): ValidateCorpusReport {
    return {
        ok: false,
        clipCount: 0,
        totalDurationSec: 0,
        issuesByFile: {},
        verdict: "error",
        summary: error,
        clips: [],
        error,
    };
}

interface RawCliReport {
    clipCount?: number;
    totalDurationSec?: number;
    verdict?: ValidateCorpusReport["verdict"];
    summary?: string;
    issuesByFile?: Record<string, string[]>;
    clips?: Array<{
        file: string;
        ok: boolean;
        durationSec?: number;
        sampleRate?: number;
        channels?: number;
        hasLyrics?: boolean;
        issues?: string[];
    }>;
}

async function runCli(dir: string): Promise<ValidateCorpusReport> {
    return new Promise((resolve) => {
        const child = spawn(
            process.execPath,
            [CLI_PATH, dir, "--json"],
            { cwd: WORKSPACE_ROOT, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
        child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
        child.on("close", (code) => {
            if (code !== 0 && !stdout.trim()) {
                resolve(makeError(`cli-exit-${code}: ${stderr.slice(0, 500)}`));
                return;
            }
            try {
                const json = JSON.parse(stdout) as RawCliReport;
                resolve({
                    ok: (json.verdict ?? "insufficient") !== "insufficient" && (json.verdict ?? "insufficient") !== "error",
                    clipCount: json.clipCount ?? 0,
                    totalDurationSec: json.totalDurationSec ?? 0,
                    verdict: json.verdict ?? "insufficient",
                    summary: json.summary ?? "(no summary)",
                    issuesByFile: json.issuesByFile ?? {},
                    clips: (json.clips ?? []).map((c) => ({
                        file: c.file,
                        ok: c.ok,
                        durationSec: c.durationSec,
                        sampleRate: c.sampleRate,
                        channels: c.channels,
                        hasLyrics: c.hasLyrics,
                        issues: c.issues ?? [],
                    })),
                });
            } catch (e) {
                resolve(makeError(`cli-json-parse: ${(e as Error).message}; stderr=${stderr.slice(0, 300)}`));
            }
        });
        child.on("error", (e) => resolve(makeError(`cli-spawn: ${e.message}`)));
    });
}
