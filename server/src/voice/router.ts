/**
 * /voice/* HTTP API.
 *
 * Exposes the voice-cloning host (server/src/voice/host.ts) to the
 * web app. All operations are scoped to the device + signed-in user
 * (same X-Device-Token + X-User-Id pattern as /library and /plugins).
 *
 * Upload model
 * ────────────
 * To keep the companion's runtime dependency footprint stable (no
 * `multer` requirement on every install) the wizard uploads one clip
 * at a time as a raw body, then "finalizes" the voice with the list
 * of staged ids it received back. Staged clips live for 1h.
 *
 *   POST   /voice/staged                 → raw audio body
 *                                            → { stagedId, bytes }
 *   POST   /voice                        → { name, engine, language,
 *                                            stagedIds:[...], notes? }
 *                                            → voice meta
 *   GET    /voice                        → list voices on this companion
 *   GET    /voice/health                 → engine availability + sidecar
 *   GET    /voice/:id                    → single voice meta
 *   POST   /voice/:id/append             → { stagedIds:[...] }
 *   POST   /voice/:id/reference          → { sampleIndex }
 *   POST   /voice/:id/rename             → { name }
 *   DELETE /voice/:id
 *   GET    /voice/:id/reference          → stream reference.wav
 *   GET    /voice/:id/sample/:n          → stream the Nth raw sample
 *   POST   /voice/:id/synthesize         → { text, language?, engine?, speed? }
 *   POST   /voice/:id/sing               → { text, language?, engine?, tempo,
 *                                            melody:[{beat,durationBeats,midiPitch}] }
 *   GET    /voice/:id/render/:renderId   → range-aware WAV stream
 *
 * Stored under <userData>/voices/<voiceId>/.
 */

import express from "express";
import path from "node:path";
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { voiceHost, type VoiceEngine, type VoiceMelodyNote } from "./host";
import { engineRegistry, type EngineId } from "./engines";
import { gpuSerial } from "./gpu-serial";
import { FFMPEG_BIN } from "../library/ffmpeg-paths";

/** Mix N "backing" stems (typically drums+bass+other) under one
 *  voice-converted vocal track using ffmpeg's amix filter. -3 dBFS
 *  output ceiling so the result is safe to ship to the DAW. */
async function mixStemsWithConvertedVocals(opts: {
    backingStems: string[];
    vocalsPath: string;
    outPath: string;
}): Promise<void> {
    const inputs = [...opts.backingStems, opts.vocalsPath];
    const args: string[] = [];
    for (const f of inputs) { args.push("-i", f); }
    // amix: equal-weight sum (mono-aware), normalize off, then loudnorm-ish
    // peak limit. Vocals get a +2 dB boost so they sit on top of the bed.
    const n = inputs.length;
    const filter = `${inputs.map((_, i) => `[${i}:a]`).join("")}amix=inputs=${n}:duration=longest:normalize=0,alimiter=limit=0.708`;
    args.push(
        "-filter_complex", filter,
        "-ac", "2",
        "-c:a", "pcm_s16le",
        "-y", opts.outPath,
    );
    await new Promise<void>((resolve, reject) => {
        const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
        let tail = "";
        // Hard 5-minute cap so a broken codec / hung pipe can't pin a worker.
        const killTimer = setTimeout(() => {
            try { proc.kill("SIGKILL"); } catch { /* ignore */ }
            reject(new Error("ffmpeg-mix timeout after 300s"));
        }, 300_000);
        proc.stderr?.on("data", (b: Buffer) => { tail = (tail + b.toString("utf8")).slice(-2000); });
        proc.on("error", (e) => { clearTimeout(killTimer); reject(e); });
        proc.on("close", (code) => {
            clearTimeout(killTimer);
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg-mix exit ${code}: ${tail.slice(-400)}`));
        });
    });
}

interface AuthedRequest extends express.Request {
    userId: string;
}

function requireUser(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
) {
    const userId = (req.headers["x-user-id"] as string | undefined)?.trim();
    if (!userId) {
        res.status(400).json({ error: "Missing X-User-Id header" });
        return;
    }
    (req as AuthedRequest).userId = userId;
    next();
}

function streamWav(req: express.Request, res: express.Response, filePath: string, downloadName: string): void {
    if (!existsSync(filePath)) {
        res.status(404).json({ error: "file-not-found" });
        return;
    }
    const stat = statSync(filePath);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("Content-Disposition", `inline; filename="${downloadName}"`);

    const range = req.headers.range;
    if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) { res.status(416).end(); return; }
        const start = match[1] === "" ? 0 : parseInt(match[1], 10);
        const end = match[2] === "" ? stat.size - 1 : parseInt(match[2], 10);
        if (start >= stat.size || end >= stat.size) { res.status(416).end(); return; }
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
        res.setHeader("Content-Length", String(end - start + 1));
        createReadStream(filePath, { start, end }).pipe(res);
        return;
    }
    res.setHeader("Content-Length", String(stat.size));
    createReadStream(filePath).pipe(res);
}

function isValidEngine(s: string | undefined): s is VoiceEngine {
    return s === "xtts" || s === "f5";
}

function parseMelody(raw: unknown): VoiceMelodyNote[] {
    if (!Array.isArray(raw)) return [];
    const out: VoiceMelodyNote[] = [];
    for (const r of raw as Array<Record<string, unknown>>) {
        const beat = Number(r.beat);
        const durationBeats = Number(r.durationBeats);
        const midiPitch = Number(r.midiPitch);
        if (!Number.isFinite(beat) || !Number.isFinite(durationBeats) || !Number.isFinite(midiPitch)) continue;
        if (durationBeats <= 0 || midiPitch <= 0) continue;
        out.push({ beat, durationBeats, midiPitch });
    }
    return out;
}

export function createVoiceRouter(authMiddleware: express.RequestHandler) {
    const router = express.Router();
    router.use(authMiddleware);
    router.use(requireUser);

    // POST /voice/staged — raw audio upload (any container; XTTS reads
    // through ffmpeg via librosa so wav/mp3/m4a/ogg all work). 25 MB cap
    // matches the wizard's 6–10s mono-WAV expectation with generous margin.
    router.post(
        "/staged",
        express.raw({ type: () => true, limit: "25mb" }),
        (req, res) => {
            const body = req.body as Buffer | undefined;
            if (!body || !Buffer.isBuffer(body) || body.length === 0) {
                res.status(400).json({ error: "empty-body" });
                return;
            }
            const filename = (req.headers["x-filename"] as string | undefined) ?? "sample.wav";
            try {
                const out = voiceHost.stageSample(body, filename);
                res.json(out);
            } catch (e) {
                res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
            }
        },
    );

    router.get("/", (_req, res) => {
        res.json({ voices: voiceHost.listVoices() });
    });

    router.get("/health", async (_req, res) => {
        try {
            const h = await voiceHost.getHealth();
            res.json(h);
        } catch (e) {
            res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    // GET /voice/engines — discovery for the additional engine sidecars
    // (demucs, rvc, ace-step, fish-speech). Each entry includes
    // capabilities and a pip install hint when the underlying python
    // package isn't installed yet. UI uses this to gate features.
    router.get("/engines", async (_req, res) => {
        try {
            const statuses = await engineRegistry.getStatus();
            res.json({ engines: statuses });
        } catch (e) {
            res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    // POST /voice/engines/demucs/separate
    // { inputPath, model?, twoStems?, stems?, mp3? }
    // → { stems: {vocals,…}, sampleRate, model, outputDir }
    // outputDir is auto-chosen under <userData>/voices/.stems/<jobId>/.
    router.post("/engines/demucs/separate", express.json({ limit: "8kb" }), async (req, res) => {
        const body = (req.body ?? {}) as {
            inputPath?: string;
            model?: string;
            twoStems?: boolean;
            stems?: string | null;
            mp3?: boolean;
        };
        if (!body.inputPath || typeof body.inputPath !== "string") {
            res.status(400).json({ error: "inputPath-required" });
            return;
        }
        try {
            // Stems land under a sibling of voicesRoot so they survive a
            // companion restart and don't pollute any single voice dir.
            const stemsRoot = voiceHost.stemsRoot();
            const jobId = `j-${Date.now().toString(36)}`;
            const outputDir = path.join(stemsRoot, jobId);
            mkdirSync(outputDir, { recursive: true });
            const data = await gpuSerial.run("demucs:separate", () => engineRegistry.send("demucs", "demucs.separate", {
                inputPath: body.inputPath,
                outputDir,
                model: body.model ?? "htdemucs",
                twoStems: Boolean(body.twoStems),
                stems: body.stems ?? null,
                mp3: Boolean(body.mp3),
            }, 600_000)) as { stems?: Record<string, string>; sampleRate?: number; model?: string };
            // Stems come back as absolute paths from the sidecar; expose
            // them as relative job artifact URLs (same shape as the song
            // endpoint) so callers can fetch via /voice/engines/jobs/...
            const stemsRel: Record<string, string> = {};
            for (const [k, abs] of Object.entries(data.stems ?? {})) {
                stemsRel[k] = path.relative(outputDir, abs).replace(/\\/g, "/");
            }
            res.json({
                jobId,
                outputDir,
                stems: stemsRel,
                sampleRate: data.sampleRate ?? 48000,
                model: data.model ?? body.model ?? "htdemucs",
                downloadBase: `/voice/engines/jobs/${jobId}/`,
            });
        } catch (e) {
            res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    // GET /voice/engines/rvc/models — inventory the user's trained
    // RVC v2 models stored under <voicesRoot>/.rvc-models/<modelId>/.
    router.get("/engines/rvc/models", async (_req, res) => {
        try {
            const data = await engineRegistry.send("rvc", "rvc.list-models", {
                modelsRoot: voiceHost.rvcModelsRoot(),
            }, 10_000) as { models?: Array<{ id: string; path: string; pth: string; index?: string; sizeMB: number }> };
            res.json({ models: data.models ?? [], modelsRoot: voiceHost.rvcModelsRoot() });
        } catch (e) {
            res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    // POST /voice/engines/rvc/convert
    // Body: { inputPath | inputStagedId, modelId, pitchSemitones?, indexRate?,
    //         f0Method?, protect?, isolateVocalsFirst? }
    // When `isolateVocalsFirst` is true, runs Demucs on inputPath first,
    // converts the vocals stem, then re-mixes with the remaining stems.
    // Result: { jobId, outputDir, converted: <rel>, mix: <rel>?, stems? }
    router.post("/engines/rvc/convert", express.json({ limit: "16kb" }), async (req, res) => {
        const body = (req.body ?? {}) as {
            inputPath?: string;
            inputStagedId?: string;
            modelId?: string;
            pitchSemitones?: number;
            indexRate?: number;
            f0Method?: string;
            protect?: number;
            filterRadius?: number;
            isolateVocalsFirst?: boolean;
        };
        let inputPath = body.inputPath;
        if (!inputPath && body.inputStagedId) {
            inputPath = voiceHost.stagedSamplePath(body.inputStagedId) ?? undefined;
        }
        if (!inputPath) {
            res.status(400).json({ error: "inputPath or inputStagedId required" }); return;
        }
        if (!body.modelId) {
            res.status(400).json({ error: "modelId required" }); return;
        }
        const modelDir = path.join(voiceHost.rvcModelsRoot(), body.modelId);
        if (!existsSync(modelDir)) {
            res.status(404).json({ error: `rvc model not found: ${body.modelId}` }); return;
        }
        try {
            const jobId = `rvc-${Date.now().toString(36)}`;
            const outputDir = path.join(voiceHost.stemsRoot(), jobId);
            mkdirSync(outputDir, { recursive: true });

            let vocalInput = inputPath;
            let preStems: Record<string, string> | undefined;
            if (body.isolateVocalsFirst) {
                const sep = await gpuSerial.run("demucs:isolate-vocals", () => engineRegistry.send("demucs", "demucs.separate", {
                    inputPath,
                    outputDir,
                    model: "htdemucs",
                    twoStems: false,
                }, 600_000)) as { stems?: Record<string, string> };
                preStems = sep.stems;
                if (preStems?.vocals && existsSync(preStems.vocals)) {
                    vocalInput = preStems.vocals;
                }
            }

            const convertedPath = path.join(outputDir, "vocals-converted.wav");
            const conv = await gpuSerial.run("rvc:convert", () => engineRegistry.send("rvc", "rvc.convert", {
                inputPath: vocalInput,
                modelDir,
                outputPath: convertedPath,
                pitchSemitones: body.pitchSemitones ?? 0,
                indexRate: body.indexRate ?? 0.66,
                f0Method: body.f0Method ?? "rmvpe",
                protect: body.protect ?? 0.33,
                filterRadius: body.filterRadius ?? 3,
            }, 600_000)) as { audioPath?: string; sampleRate?: number; durationSec?: number; device?: string };

            // Re-mix with the non-vocal stems if we isolated.
            let mixRel: string | undefined;
            if (preStems && Object.keys(preStems).length > 1) {
                const mixPath = path.join(outputDir, "remix.wav");
                try {
                    await mixStemsWithConvertedVocals({
                        backingStems: Object.entries(preStems)
                            .filter(([k]) => k !== "vocals")
                            .map(([, v]) => v),
                        vocalsPath: convertedPath,
                        outPath: mixPath,
                    });
                    mixRel = path.relative(outputDir, mixPath).replace(/\\/g, "/");
                } catch {
                    // Best-effort remix; non-fatal.
                }
            }

            const toRel = (abs?: string) => abs ? path.relative(outputDir, abs).replace(/\\/g, "/") : undefined;
            const stemsRel: Record<string, string> = {};
            for (const [k, v] of Object.entries(preStems ?? {})) {
                const r = toRel(v); if (r) stemsRel[k] = r;
            }

            res.json({
                jobId,
                outputDir,
                converted: toRel(conv.audioPath ?? convertedPath),
                mix: mixRel,
                stems: stemsRel,
                sampleRate: conv.sampleRate ?? 48000,
                durationSec: conv.durationSec ?? 0,
                device: conv.device ?? "cpu",
                downloadBase: `/voice/engines/jobs/${jobId}/`,
            });
        } catch (e) {
            res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    // GET /voice/engines/ace-step/loras — list trained LoRA checkpoints
    // discovered under <voicesRoot>/../lora-training/exps/<exp>/ckpts/*.ckpt.
    // Populated by scripts/train-acestep-lora.ps1.
    router.get("/engines/ace-step/loras", (_req, res) => {
        const root = voiceHost.lorasRoot();
        const out: Array<{ exp: string; ckpts: Array<{ name: string; absPath: string; sizeMB: number }> }> = [];
        try {
            for (const exp of readdirSync(root, { withFileTypes: true })) {
                if (!exp.isDirectory()) continue;
                const ckptsDir = path.join(root, exp.name, "ckpts");
                if (!existsSync(ckptsDir)) continue;
                const ckpts: Array<{ name: string; absPath: string; sizeMB: number }> = [];
                for (const f of readdirSync(ckptsDir)) {
                    if (!f.endsWith(".ckpt")) continue;
                    const abs = path.join(ckptsDir, f);
                    const s = statSync(abs);
                    ckpts.push({ name: f, absPath: abs, sizeMB: Math.round(s.size / 1048576) });
                }
                if (ckpts.length) out.push({ exp: exp.name, ckpts });
            }
        } catch {
            // Empty list on errors.
        }
        res.json({ loras: out });
    });

    // POST /voice/engines/ace-step/song — full song-generation pipeline.
    // Body: { prompt, lyrics?, durationSec?, inferStep?, guidanceScale?,
    //         seeds?, loraPath?, loraWeight?, splitStems? }
    // Produces a song wav and, when splitStems!==false, runs Demucs to
    // produce drums/bass/other/vocals. Returns paths under
    // <stemsRoot>/<jobId>/ plus a relative path the caller can fetch.
    router.post("/engines/ace-step/song", express.json({ limit: "32kb" }), async (req, res) => {
        const body = (req.body ?? {}) as {
            prompt?: string;
            lyrics?: string;
            durationSec?: number;
            inferStep?: number;
            guidanceScale?: number;
            seeds?: number[];
            loraPath?: string;
            loraWeight?: number;
            loraPaths?: string[];
            loraWeights?: number[];
            splitStems?: boolean;
        };
        if (!body.prompt || typeof body.prompt !== "string") {
            res.status(400).json({ error: "prompt-required" });
            return;
        }
        try {
            const stemsRoot = voiceHost.stemsRoot();
            const jobId = `s-${Date.now().toString(36)}`;
            const outputDir = path.join(stemsRoot, jobId);
            mkdirSync(outputDir, { recursive: true });
            const songPath = path.join(outputDir, "song.wav");

            const gen = await gpuSerial.run("ace-step:generate", () => engineRegistry.send("ace-step", "acestep.generate", {
                prompt: body.prompt,
                lyrics: body.lyrics ?? "",
                durationSec: body.durationSec ?? 30,
                inferStep: body.inferStep ?? 30,
                guidanceScale: body.guidanceScale ?? 15,
                seeds: body.seeds ?? null,
                loraPath: body.loraPath ?? null,
                loraWeight: body.loraWeight ?? 1.0,
                ...(Array.isArray(body.loraPaths) && body.loraPaths.length > 0
                    ? { loraPaths: body.loraPaths, loraWeights: body.loraWeights ?? body.loraPaths.map(() => 1.0) }
                    : {}),
                outputPath: songPath,
            }, 900_000)) as { audioPath?: string; sampleRate?: number; device?: string };

            const finalSong = gen.audioPath && existsSync(gen.audioPath) ? gen.audioPath : songPath;

            let stems: Record<string, string> | undefined;
            if (body.splitStems !== false && existsSync(finalSong)) {
                const sep = await gpuSerial.run("demucs:post-acestep", () => engineRegistry.send("demucs", "demucs.separate", {
                    inputPath: finalSong,
                    outputDir,
                    model: "htdemucs",
                    twoStems: false,
                }, 600_000)) as { stems?: Record<string, string> };
                stems = sep.stems;
            }

            const toRel = (abs: string | undefined): string | undefined =>
                abs ? path.relative(outputDir, abs).replace(/\\/g, "/") : undefined;
            const stemsRel: Record<string, string> = {};
            for (const [k, v] of Object.entries(stems ?? {})) {
                const r = toRel(v); if (r) stemsRel[k] = r;
            }

            res.json({
                jobId,
                outputDir,
                song: toRel(finalSong),
                stems: stemsRel,
                sampleRate: gen.sampleRate ?? 48000,
                device: gen.device ?? "unknown",
                downloadBase: `/voice/engines/jobs/${jobId}/`,
            });
        } catch (e) {
            res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    // GET /voice/engines/jobs/:jobId/:file — stream an artifact produced
    // by one of the engine endpoints (song.wav, song.vocals.wav, etc.).
    router.get("/engines/jobs/:jobId/:file", (req, res) => {
        const jobId = req.params.jobId;
        const file = req.params.file;
        if (!/^[A-Za-z0-9_.-]+$/.test(jobId) || !/^[A-Za-z0-9_.-]+$/.test(file)) {
            res.status(400).json({ error: "bad-path" });
            return;
        }
        const abs = path.join(voiceHost.stemsRoot(), jobId, file);
        if (!existsSync(abs)) { res.status(404).json({ error: "not-found" }); return; }
        const stat = statSync(abs);
        res.setHeader("Content-Type", file.endsWith(".mp3") ? "audio/mpeg" : "audio/wav");
        res.setHeader("Content-Length", String(stat.size));
        res.setHeader("Cache-Control", "private, max-age=3600");
        createReadStream(abs).pipe(res);
    });

    // POST /voice/engines/clap/embed — one-shot CLAP audio embedding
    // (laion/larger_clap_music_and_speech, 512-d L2-normalized vectors).
    //
    // Unlike the long-lived sidecars, CLAP is invoked ad-hoc per asset
    // via `server/python/_clap_embed.py --in <audio> --out <result.json>`.
    // The python venv is created by `server/scripts/install-clap-venv.ps1`
    // and its interpreter is found via the CLAP_PYTHON_BIN env var (or
    // falls back to the system python with a hint when missing).
    //
    // Body: { inputPath: string, device?: "cpu" | "cuda" }
    // Reply: { ok: true, embedding: number[512], model, dim, durationSec? }
    router.post("/engines/clap/embed", express.json({ limit: "4kb" }), async (req, res) => {
        const body = (req.body ?? {}) as { inputPath?: string; device?: "cpu" | "cuda" };
        if (!body.inputPath || typeof body.inputPath !== "string") {
            res.status(400).json({ error: "inputPath-required" });
            return;
        }
        if (!existsSync(body.inputPath)) {
            res.status(404).json({ error: "input-not-found", inputPath: body.inputPath });
            return;
        }
        const pyBin = process.env.CLAP_PYTHON_BIN;
        if (!pyBin || !existsSync(pyBin)) {
            res.status(503).json({
                error: "clap-venv-missing",
                hint: "Run server/scripts/install-clap-venv.ps1 then set CLAP_PYTHON_BIN.",
            });
            return;
        }
        // Resolve script (dev / packaged-resource fallback chain).
        const scriptCandidates = [
            path.join(
                (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? "",
                "python",
                "_clap_embed.py",
            ),
            path.join(__dirname, "..", "..", "python", "_clap_embed.py"),
            path.join(process.cwd(), "python", "_clap_embed.py"),
        ];
        const scriptPath = scriptCandidates.find((c) => c && existsSync(c));
        if (!scriptPath) {
            res.status(500).json({ error: "clap-script-missing" });
            return;
        }
        // Each call writes to a unique tmp file to avoid races.
        const os = await import("node:os");
        const fsp = await import("node:fs/promises");
        const { spawn } = await import("node:child_process");
        const outPath = path.join(os.tmpdir(), `clap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`);
        const args = ["-u", scriptPath, "--in", body.inputPath, "--out", outPath];
        if (body.device === "cpu" || body.device === "cuda") args.push("--device", body.device);
        try {
            const stderr: Buffer[] = [];
            const code: number = await new Promise((resolve, reject) => {
                const ch = spawn(pyBin, args, { stdio: ["ignore", "ignore", "pipe"] });
                ch.stderr.on("data", (d: Buffer) => { stderr.push(d); });
                ch.on("error", reject);
                ch.on("close", (c) => resolve(c ?? -1));
            });
            if (code !== 0) {
                const err = Buffer.concat(stderr).toString("utf-8").slice(-2000);
                res.status(500).json({ error: "clap-script-failed", exitCode: code, stderr: err });
                return;
            }
            const raw = await fsp.readFile(outPath, "utf-8");
            const parsed = JSON.parse(raw) as { embedding?: number[]; model?: string; dim?: number; durationSec?: number };
            await fsp.unlink(outPath).catch(() => {});
            if (!Array.isArray(parsed.embedding) || parsed.embedding.length === 0) {
                res.status(500).json({ error: "empty-embedding" });
                return;
            }
            res.json({
                ok: true,
                embedding: parsed.embedding,
                model: parsed.model ?? "laion/larger_clap_music_and_speech",
                dim: parsed.dim ?? parsed.embedding.length,
                durationSec: parsed.durationSec ?? null,
            });
        } catch (e) {
            res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    // Generic passthrough for the other engines. Tightly scoped to a
    // known engine id + command kind so we don't accidentally expose
    // arbitrary sidecar control to the web app. Callers send the same
    // payload the python handler expects (sans `id`/`kind`).
    router.post("/engines/:engineId/:command", express.json({ limit: "64kb" }), async (req, res) => {
        const validEngines: EngineId[] = ["demucs", "rvc", "ace-step", "fish-speech"];
        const engineId = req.params.engineId as EngineId;
        const command = req.params.command;
        if (!validEngines.includes(engineId)) {
            res.status(400).json({ error: `unknown-engine: ${engineId}` });
            return;
        }
        // Whitelist command prefixes so we don't expose `ping` etc. as
        // public API. Each engine declares its own kinds in python.
        const allowedPrefixes: Record<EngineId, string[]> = {
            "demucs": ["demucs."],
            "rvc": ["rvc."],
            "ace-step": ["acestep."],
            "fish-speech": ["fish."],
        };
        const fullKind = command.includes(".") ? command : `${engineId.replace("-", "")}.${command}`;
        if (!allowedPrefixes[engineId].some((p) => fullKind.startsWith(p))) {
            res.status(400).json({ error: `command-not-allowed: ${fullKind}` });
            return;
        }
        try {
            const data = await engineRegistry.send(engineId, fullKind, (req.body ?? {}) as Record<string, unknown>, 600_000);
            res.json(data);
        } catch (e) {
            res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    router.post("/staged/:stagedId/analyze", express.json({ limit: "4kb" }), async (req, res) => {
        const body = (req.body ?? {}) as { expectedText?: string; language?: string; intent?: string };
        try {
            const data = await voiceHost.analyzeStagedSample({
                stagedId: req.params.stagedId,
                expectedText: body.expectedText,
                language: body.language,
                intent: body.intent,
            });
            res.json(data);
        } catch (e) {
            res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    router.post("/:id/sample/:n/analyze", express.json({ limit: "4kb" }), async (req, res) => {
        const idx = Number(req.params.n);
        if (!Number.isInteger(idx) || idx < 0) { res.status(400).json({ error: "bad-index" }); return; }
        const body = (req.body ?? {}) as { expectedText?: string; language?: string; intent?: string };
        try {
            const data = await voiceHost.analyzeVoiceSample({
                voiceId: req.params.id,
                sampleIndex: idx,
                expectedText: body.expectedText,
                language: body.language,
                intent: body.intent,
            });
            res.json(data);
        } catch (e) {
            res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    // POST /voice/pitch-coverage
    // Body: { stagedIds?: string[], voiceId?: string }
    // → { coveragePct, coveredBins, totalBins, lowMidi, highMidi,
    //     histogram, biggestGaps, voicedSecTotal, audioSecTotal, verdict }
    router.post("/pitch-coverage", express.json({ limit: "8kb" }), async (req, res) => {
        const body = (req.body ?? {}) as { stagedIds?: string[]; voiceId?: string };
        if (!body.stagedIds?.length && !body.voiceId) {
            res.status(400).json({ error: "stagedIds or voiceId required" }); return;
        }
        try {
            const data = await voiceHost.analyzePitchCoverage({
                stagedIds: body.stagedIds,
                voiceId: body.voiceId,
            });
            res.json(data);
        } catch (e) {
            res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    router.post("/", express.json({ limit: "16kb" }), (req, res) => {
        const body = (req.body ?? {}) as {
            name?: string; engine?: string; language?: string;
            stagedIds?: string[]; notes?: string;
        };
        if (!Array.isArray(body.stagedIds) || !body.stagedIds.length) {
            res.status(400).json({ error: "stagedIds required" });
            return;
        }
        const engine = isValidEngine(body.engine) ? body.engine : "xtts";
        try {
            const meta = voiceHost.createVoiceFromStaged({
                name: body.name || "Untitled voice",
                engine,
                language: (body.language || "en").trim(),
                notes: body.notes?.trim(),
                stagedIds: body.stagedIds,
            });
            res.json(meta);
        } catch (e) {
            res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    router.get("/:id", (req, res) => {
        const v = voiceHost.getVoice(req.params.id);
        if (!v) { res.status(404).json({ error: "voice-not-found" }); return; }
        res.json(v);
    });

    router.post("/:id/append", express.json({ limit: "16kb" }), (req, res) => {
        const body = (req.body ?? {}) as { stagedIds?: string[] };
        if (!Array.isArray(body.stagedIds) || !body.stagedIds.length) {
            res.status(400).json({ error: "stagedIds required" });
            return;
        }
        try {
            const meta = voiceHost.appendStagedSamples(req.params.id, body.stagedIds);
            res.json(meta);
        } catch (e) {
            res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    router.post("/:id/reference", express.json({ limit: "1kb" }), (req, res) => {
        const body = (req.body ?? {}) as { sampleIndex?: number };
        if (typeof body.sampleIndex !== "number") {
            res.status(400).json({ error: "sampleIndex required" }); return;
        }
        try {
            const meta = voiceHost.setReference(req.params.id, body.sampleIndex);
            res.json(meta);
        } catch (e) {
            res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    router.post("/:id/rename", express.json({ limit: "1kb" }), (req, res) => {
        const body = (req.body ?? {}) as { name?: string };
        if (!body.name) { res.status(400).json({ error: "name required" }); return; }
        try {
            const meta = voiceHost.renameVoice(req.params.id, body.name);
            res.json(meta);
        } catch (e) {
            res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    router.delete("/:id", (req, res) => {
        try {
            voiceHost.deleteVoice(req.params.id);
            res.json({ ok: true });
        } catch (e) {
            res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    router.get("/:id/reference", (req, res) => {
        const p = voiceHost.referenceFilePath(req.params.id);
        if (!p) { res.status(404).json({ error: "reference-missing" }); return; }
        streamWav(req, res, p, `${req.params.id}-reference.wav`);
    });

    router.get("/:id/sample/:n", (req, res) => {
        const meta = voiceHost.getVoice(req.params.id);
        if (!meta) { res.status(404).json({ error: "voice-not-found" }); return; }
        const idx = Number(req.params.n);
        if (!Number.isInteger(idx) || idx < 0 || idx >= meta.samples.length) {
            res.status(404).json({ error: "sample-not-found" }); return;
        }
        const abs = path.join(voiceHost.voiceDir(req.params.id), meta.samples[idx]);
        streamWav(req, res, abs, `${req.params.id}-sample-${idx}.wav`);
    });

    router.post("/:id/synthesize", express.json({ limit: "256kb" }), async (req, res) => {
        const body = (req.body ?? {}) as {
            text?: string; language?: string; engine?: string; speed?: number;
        };
        if (!body.text || !body.text.trim()) {
            res.status(400).json({ error: "text required" }); return;
        }
        try {
            const result = await voiceHost.synthesize({
                voiceId: req.params.id,
                text: body.text,
                language: body.language,
                engine: isValidEngine(body.engine) ? body.engine : undefined,
                speed: typeof body.speed === "number" ? body.speed : undefined,
            });
            res.json({
                renderId: result.renderId,
                durationSec: result.durationSec,
                sampleRate: result.sampleRate,
                engine: result.engine,
                language: result.language,
                streamUrl: `/voice/${encodeURIComponent(req.params.id)}/render/${result.renderId}`,
            });
        } catch (e) {
            res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    router.post("/:id/sing", express.json({ limit: "512kb" }), async (req, res) => {
        const body = (req.body ?? {}) as {
            text?: string; language?: string; engine?: string;
            tempo?: number; melody?: unknown;
            polish?: boolean; vibratoCents?: number; vibratoRateHz?: number;
        };
        if (!body.text || !body.text.trim()) {
            res.status(400).json({ error: "text required" }); return;
        }
        const melody = parseMelody(body.melody);
        if (!melody.length) {
            res.status(400).json({ error: "melody required (non-empty array of {beat,durationBeats,midiPitch})" });
            return;
        }
        const tempo = typeof body.tempo === "number" && body.tempo > 20 && body.tempo < 400 ? body.tempo : 120;
        try {
            const result = await voiceHost.sing({
                voiceId: req.params.id,
                text: body.text,
                language: body.language,
                engine: isValidEngine(body.engine) ? body.engine : undefined,
                tempo,
                melody,
                polish: body.polish !== false,
                vibratoCents: typeof body.vibratoCents === "number" ? body.vibratoCents : undefined,
                vibratoRateHz: typeof body.vibratoRateHz === "number" ? body.vibratoRateHz : undefined,
            });
            res.json({
                renderId: result.renderId,
                durationSec: result.durationSec,
                sampleRate: result.sampleRate,
                engine: result.engine,
                language: result.language,
                streamUrl: `/voice/${encodeURIComponent(req.params.id)}/render/${result.renderId}`,
            });
        } catch (e) {
            res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    router.get("/:id/render/:renderId", (req, res) => {
        const p = voiceHost.renderOutputPath(req.params.id, req.params.renderId);
        if (!p) { res.status(404).json({ error: "render-not-found" }); return; }
        streamWav(req, res, p, `${req.params.id}-${req.params.renderId}.wav`);
    });

    return router;
}
