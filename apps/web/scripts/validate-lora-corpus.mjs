#!/usr/bin/env node
/**
 * LoRA training corpus validator for ACE-Step.
 *
 * Walks a folder of audio files (+ optional .txt sidecars containing lyrics
 * or genre tags) and produces a readable report listing:
 *   - files that pass quality gates
 *   - files that should be re-encoded / re-trimmed (with the exact reason)
 *
 * Gates are based on the upstream ACE-Step training notes
 * (https://github.com/ace-step/ACE-Step#training):
 *
 *   sample rate ≥ 16 kHz                        (44.1/48 kHz strongly preferred)
 *   channels    1 or 2                          (5.1+ rejected)
 *   duration    10s ≤ d ≤ 300s                  (shorter clips don't have enough
 *                                                 structure; longer ones blow VRAM)
 *   format      wav / flac / mp3 / ogg / opus
 *   if .txt:    non-empty, < 4 KB, UTF-8
 *
 * Recommended dataset shape:
 *   ≥ 30 clips, ≥ 5 minutes total, same genre/style/tempo range.
 *
 * Usage:
 *   node scripts/validate-lora-corpus.mjs <folder> [--json] [--strict]
 *
 *   --json     emit a machine-readable JSON report to stdout
 *              (the human report still goes to stderr)
 *   --strict   exit 1 if any file fails (CI-friendly)
 *
 * Requires `ffprobe` on PATH. The bundled FFmpeg sidecar already has it;
 * on dev machines `winget install Gyan.FFmpeg` or `brew install ffmpeg`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const flagJson = args.includes("--json");
const flagStrict = args.includes("--strict");
const positional = args.filter((a) => !a.startsWith("--"));

if (positional.length !== 1) {
    console.error("Usage: validate-lora-corpus.mjs <folder> [--json] [--strict]");
    process.exit(2);
}

const root = resolve(positional[0]);
if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`Not a directory: ${root}`);
    process.exit(2);
}

const AUDIO_EXT = new Set([".wav", ".flac", ".mp3", ".ogg", ".opus", ".m4a"]);

const MIN_SAMPLE_RATE = 16000;
const RECOMMENDED_SAMPLE_RATE = 44100;
const MIN_DURATION_SEC = 10;
const MAX_DURATION_SEC = 300;
const MIN_CORPUS_CLIPS = 30;
const MIN_CORPUS_SECONDS = 5 * 60;

const RESET = "\u001b[0m";
const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const DIM = "\u001b[2m";

function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.isFile() && AUDIO_EXT.has(extname(entry.name).toLowerCase())) {
            out.push(full);
        }
    }
    return out;
}

function ffprobe(file) {
    const res = spawnSync(
        "ffprobe",
        [
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            "-select_streams", "a:0",
            file,
        ],
        { encoding: "utf8" },
    );
    if (res.status !== 0) {
        return { ok: false, error: res.stderr?.trim() || "ffprobe failed" };
    }
    try {
        const j = JSON.parse(res.stdout);
        const stream = j.streams?.[0];
        const format = j.format;
        if (!stream || !format) return { ok: false, error: "no audio stream" };
        return {
            ok: true,
            sampleRate: parseInt(stream.sample_rate, 10),
            channels: stream.channels,
            duration: parseFloat(format.duration ?? stream.duration ?? "0"),
            codec: stream.codec_name,
            bitrate: format.bit_rate ? parseInt(format.bit_rate, 10) : null,
        };
    } catch (err) {
        return { ok: false, error: `parse failed: ${err.message}` };
    }
}

function validateLyricsSidecar(audioFile) {
    const txt = audioFile.replace(/\.[^.]+$/, ".txt");
    if (!existsSync(txt)) return { present: false };
    const stat = statSync(txt);
    if (stat.size === 0) return { present: true, ok: false, error: "empty .txt" };
    if (stat.size > 4096) return { present: true, ok: false, error: ".txt > 4KB" };
    try {
        const body = readFileSync(txt, "utf8");
        if (!body.trim()) return { present: true, ok: false, error: "whitespace-only .txt" };
        return { present: true, ok: true, chars: body.length };
    } catch {
        return { present: true, ok: false, error: "not valid UTF-8" };
    }
}

const files = walk(root);
if (files.length === 0) {
    console.error(`No audio files found under ${root}`);
    process.exit(2);
}

const report = {
    root,
    total: files.length,
    passed: [],
    warnings: [],
    failed: [],
    summary: {},
};

for (const file of files) {
    const rel = relative(root, file);
    const probe = ffprobe(file);
    if (!probe.ok) {
        report.failed.push({ file: rel, reason: probe.error });
        continue;
    }
    const issues = [];
    const warnings = [];
    if (probe.sampleRate < MIN_SAMPLE_RATE) {
        issues.push(`sample rate ${probe.sampleRate} Hz < ${MIN_SAMPLE_RATE}`);
    } else if (probe.sampleRate < RECOMMENDED_SAMPLE_RATE) {
        warnings.push(`sample rate ${probe.sampleRate} Hz < ${RECOMMENDED_SAMPLE_RATE} (recommended)`);
    }
    if (probe.channels < 1 || probe.channels > 2) {
        issues.push(`channels=${probe.channels} (must be 1 or 2)`);
    }
    if (!probe.duration || probe.duration < MIN_DURATION_SEC) {
        issues.push(`duration ${probe.duration.toFixed(1)}s < ${MIN_DURATION_SEC}s`);
    } else if (probe.duration > MAX_DURATION_SEC) {
        issues.push(`duration ${probe.duration.toFixed(1)}s > ${MAX_DURATION_SEC}s`);
    }

    const lyrics = validateLyricsSidecar(file);
    if (lyrics.present && !lyrics.ok) {
        issues.push(`lyrics: ${lyrics.error}`);
    }

    const entry = {
        file: rel,
        sampleRate: probe.sampleRate,
        channels: probe.channels,
        duration: Number(probe.duration.toFixed(2)),
        codec: probe.codec,
        lyrics: lyrics.present,
        warnings,
    };

    if (issues.length) {
        report.failed.push({ ...entry, issues });
    } else if (warnings.length) {
        report.warnings.push(entry);
    } else {
        report.passed.push(entry);
    }
}

const totalSeconds = [...report.passed, ...report.warnings].reduce((s, e) => s + e.duration, 0);
const usableClips = report.passed.length + report.warnings.length;

report.summary = {
    usableClips,
    totalSeconds: Number(totalSeconds.toFixed(1)),
    meetsMinClips: usableClips >= MIN_CORPUS_CLIPS,
    meetsMinDuration: totalSeconds >= MIN_CORPUS_SECONDS,
    recommendation:
        usableClips >= MIN_CORPUS_CLIPS && totalSeconds >= MIN_CORPUS_SECONDS
            ? "ready-to-train"
            : usableClips >= 10
                ? "minimal-corpus (training will work but quality will be limited)"
                : "insufficient (gather more clips before training)",
};

if (flagJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

// Always emit the human report to stderr so it doesn't pollute --json piping.
const log = (...a) => console.error(...a);
log(`${DIM}LoRA corpus report — ${root}${RESET}`);
log("");
log(`${GREEN}PASS${RESET} ${report.passed.length}`);
log(`${YELLOW}WARN${RESET} ${report.warnings.length}`);
log(`${RED}FAIL${RESET} ${report.failed.length}`);
log("");
if (report.failed.length) {
    log(`${RED}─── failures ───${RESET}`);
    for (const f of report.failed) {
        const issues = f.issues ? f.issues.join("; ") : f.reason;
        log(`  ${RED}✗${RESET} ${f.file}  ${DIM}${issues}${RESET}`);
    }
    log("");
}
if (report.warnings.length) {
    log(`${YELLOW}─── warnings ───${RESET}`);
    for (const w of report.warnings) {
        log(`  ${YELLOW}!${RESET} ${w.file}  ${DIM}${w.warnings.join("; ")}${RESET}`);
    }
    log("");
}
log(`${DIM}Usable clips: ${usableClips} / ${MIN_CORPUS_CLIPS} required`);
log(`Total audio:  ${(totalSeconds / 60).toFixed(1)} min / ${MIN_CORPUS_SECONDS / 60} min recommended${RESET}`);
log(`Verdict:      ${report.summary.recommendation}`);

if (flagStrict && report.failed.length > 0) {
    process.exit(1);
}
process.exit(0);
