/**
 * Engine registry — owns every Python sidecar in the companion.
 *
 * Each engine is a long-lived Python child process that speaks the
 * NDJSON protocol from `_sidecar.py`. The registry:
 *
 *   • Resolves script paths (dev vs packaged-resource).
 *   • Lazily instantiates one Sidecar per engine.
 *   • Probes status via the `hello` event (engineId, version,
 *     capabilities, install hint, device).
 *   • Routes commands to engines by id.
 *   • Cleans up on shutdown.
 *
 * The legacy voice-cloning sidecar (voice_clone.py) stays owned by
 * VoiceHost — its public API surface is much larger than the others
 * and predates this registry. New engines live here.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { log } from "../lib/logger";
import { Sidecar, type SidecarHello, type SidecarProgress } from "./sidecar";

export type EngineId = "demucs" | "rvc" | "ace-step" | "fish-speech";

interface EngineSpec {
    id: EngineId;
    scriptName: string;
    env?: NodeJS.ProcessEnv;
    /** Override the python interpreter (relative to server/python or absolute).
     *  Some engines have hard dep pins that conflict with the main env
     *  (e.g. ACE-Step needs transformers==4.50, coqui-tts needs >=4.57)
     *  so they live in their own venv under server/python/.venvs/<id>/. */
    pythonExe?: string;
    /** Kill the python child after this many ms of idleness so its VRAM
     *  is released back to the GPU. The next request respawns it.
     *  Tuned per-engine: heavy models that take a long time to load (e.g.
     *  ACE-Step ~30s) get a longer grace period than tiny ones. */
    idleEvictMs?: number;
}

const ENGINES: EngineSpec[] = [
    // Demucs htdemucs is ~80 MB on its own but holds tensor activations
    // (~1–2 GB during a long song). Evict aggressively.
    { id: "demucs", scriptName: "demucs_sidecar.py", idleEvictMs: 120_000 },
    // RVC: small models (~200 MB each) but loads stack up over a session.
    { id: "rvc", scriptName: "rvc_sidecar.py", idleEvictMs: 180_000 },
    {
        id: "ace-step",
        scriptName: "ace_step_sidecar.py",
        // Created by: python -m venv server/python/.venvs/ace_step --system-site-packages
        //             then `pip install git+https://github.com/ace-step/ACE-Step.git`
        pythonExe: ".venvs/ace_step/Scripts/python.exe",
        // Heavy load (~30s + 6 GB VRAM). Hold longer so a follow-up chat
        // turn doesn't pay the reload cost, but still evict between
        // independent user actions.
        idleEvictMs: 300_000,
    },
    // Fish Speech 2.0 pins torch==2.8.0 + transformers<=4.57.3; runs in its
    // own venv to avoid clashing with the base env. Like ace-step, the venv is
    // created with --system-site-packages and torch is then uninstalled from
    // the venv so it inherits base's CUDA torch.
    {
        id: "fish-speech",
        scriptName: "fish_speech_sidecar.py",
        env: { COQUI_TOS_AGREED: "1" },
        pythonExe: ".venvs/fish_speech/Scripts/python.exe",
        idleEvictMs: 240_000,
    },
];

export interface EngineStatus {
    id: EngineId;
    ready: boolean;
    installed: boolean;
    capabilities: string[];
    version?: string;
    device?: SidecarHello["device"];
    installHint?: string | null;
    /** Last error from the probe, if any. */
    error?: string;
    /** Engine-specific extras from hello (e.g. demucs.models, fish.languages). */
    extra?: Record<string, unknown>;
}

class EngineRegistry {
    private sidecars = new Map<EngineId, Sidecar>();
    private lastStatus = new Map<EngineId, EngineStatus>();

    private scriptPath(scriptName: string): string {
        const candidates = [
            path.join(
                (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? "",
                "python",
                scriptName,
            ),
            path.join(__dirname, "..", "..", "python", scriptName),
            path.join(process.cwd(), "python", scriptName),
        ];
        return candidates.find((c) => c && existsSync(c)) ?? candidates[candidates.length - 1];
    }

    /** Resolve a python interpreter override. Absolute path → use as-is.
     *  Relative → resolved against the same dir that holds the scripts. */
    private resolvePython(pythonExe: string | undefined, scriptName: string): string | undefined {
        if (!pythonExe) return undefined;
        if (path.isAbsolute(pythonExe) && existsSync(pythonExe)) return pythonExe;
        const scriptDir = path.dirname(this.scriptPath(scriptName));
        const candidate = path.resolve(scriptDir, pythonExe);
        return existsSync(candidate) ? candidate : undefined;
    }

    /** Lazy get-or-create. Spawns the python child on first call. */
    get(id: EngineId): Sidecar {
        const existing = this.sidecars.get(id);
        if (existing) return existing;
        const spec = ENGINES.find((e) => e.id === id);
        if (!spec) throw new Error(`unknown-engine: ${id}`);
        const sc = new Sidecar({
            name: id,
            scriptPath: this.scriptPath(spec.scriptName),
            pythonExe: this.resolvePython(spec.pythonExe, spec.scriptName),
            env: { PYTHONIOENCODING: "utf-8", ...(spec.env ?? {}) },
            idleEvictMs: spec.idleEvictMs,
        });
        sc.on("exit", () => {
            // Force a fresh Sidecar on the next .get() so crash recovery
            // and dev script-restart both yield a clean instance.
            this.sidecars.delete(id);
        });
        this.sidecars.set(id, sc);
        return sc;
    }

    /** Send a command to a specific engine. */
    async send(
        id: EngineId,
        kind: string,
        args: Record<string, unknown>,
        timeoutMs: number,
        onProgress?: (p: SidecarProgress) => void,
    ): Promise<Record<string, unknown>> {
        return this.get(id).send(kind, args, timeoutMs, onProgress);
    }

    /**
     * Probe every engine. Spawns each python child (cheap for stubs)
     * and reads its hello event. Failures (script missing, python OOM,
     * dep import error before hello) are surfaced as `error` on the
     * status entry rather than throwing.
     */
    async getStatus(opts: { timeoutMs?: number } = {}): Promise<EngineStatus[]> {
        const timeoutMs = opts.timeoutMs ?? 15_000;
        const out = await Promise.all(
            ENGINES.map(async (spec): Promise<EngineStatus> => {
                try {
                    const sc = this.get(spec.id);
                    // Race ready() against a shorter probe timeout so a
                    // wedged sidecar doesn't block the whole status call.
                    const hello = await Promise.race([
                        sc.ready(),
                        new Promise<never>((_r, rej) =>
                            setTimeout(() => rej(new Error("probe-timeout")), timeoutMs).unref(),
                        ),
                    ]);
                    const status: EngineStatus = {
                        id: spec.id,
                        ready: true,
                        installed: Boolean((hello as Record<string, unknown>).installed ?? true),
                        capabilities: Array.isArray(hello.capabilities) ? hello.capabilities : [],
                        version: hello.version,
                        device: hello.device,
                        installHint: (hello as Record<string, unknown>).installHint as string | null | undefined,
                        extra: hello,
                    };
                    this.lastStatus.set(spec.id, status);
                    return status;
                } catch (e) {
                    const err = e instanceof Error ? e.message : String(e);
                    const status: EngineStatus = {
                        id: spec.id,
                        ready: false,
                        installed: false,
                        capabilities: [],
                        error: err,
                    };
                    this.lastStatus.set(spec.id, status);
                    return status;
                }
            }),
        );
        log.info("engines.probe", {
            engines: out.map((s) => ({ id: s.id, ready: s.ready, capabilities: s.capabilities })),
        });
        return out;
    }

    /** Return the last cached status without re-probing (or null). */
    getCachedStatus(id: EngineId): EngineStatus | null {
        return this.lastStatus.get(id) ?? null;
    }

    /** Tear down every sidecar (called from companion shutdown). */
    shutdown(): void {
        for (const sc of this.sidecars.values()) {
            try { sc.dispose(); } catch { /* noop */ }
        }
        this.sidecars.clear();
    }
}

export const engineRegistry = new EngineRegistry();
