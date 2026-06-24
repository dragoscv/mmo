/**
 * Managed Python environment for the analyzer.
 *
 * The analyzer needs a Python the heavy audio packages (audio-separator,
 * librosa, …) actually have wheels for. The user's system Python may be too
 * new (e.g. 3.14, where audio-separator's Cython deps fail to build) or
 * missing entirely. To make "stems work completely" with zero manual steps we
 * provision an **isolated, managed** interpreter:
 *
 *   1. Ensure the `uv` binary (tiny, static) is available — bundled in
 *      resources when packaged, else downloaded once into userData.
 *   2. `uv venv --python 3.12` creates a dedicated venv under
 *      `{userData}/pyenv` — uv auto-downloads a standalone CPython 3.12 if the
 *      machine doesn't have one. Never touches system Python.
 *   3. The analyzer points `MMO_PYTHON` at that venv's interpreter.
 *
 * Everything is idempotent: an existing healthy venv is reused, and only
 * missing pieces are fetched. All long steps stream progress so the UI can
 * show a friendly window.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import { app } from "electron";
import { pushDebugLog } from "../debug-log";

export interface EnvProgress {
    /** Coarse phase id for the UI. */
    stage: "uv" | "venv" | "python" | "done" | "error";
    /** 0..1 within the overall env-provisioning step. */
    pct: number;
    msg: string;
}

/** Target CPython for the analyzer venv. 3.12 has wheels for the whole
 *  audio stack (audio-separator, onnxruntime, numba/librosa, torch). */
const PYTHON_VERSION = "3.12";

function userDataDir(): string {
    try { return app.getPath("userData"); } catch { return process.cwd(); }
}

/** Root of the managed env. */
export function pyenvDir(): string {
    return path.join(userDataDir(), "pyenv");
}

/** Absolute path to the venv's python executable (may not exist yet). */
export function venvPython(): string {
    const dir = pyenvDir();
    return process.platform === "win32"
        ? path.join(dir, "Scripts", "python.exe")
        : path.join(dir, "bin", "python");
}

/** True when the managed venv already has a working interpreter. */
export function venvReady(): boolean {
    try { return fs.existsSync(venvPython()); } catch { return false; }
}

const isWin = process.platform === "win32";
const UV_EXE = isWin ? "uv.exe" : "uv";

/** Locate a usable `uv`: bundled resource → userData cache → PATH. */
function locateUv(): string | null {
    if (app.isPackaged) {
        const packed = path.join(process.resourcesPath, "uv", UV_EXE);
        if (fs.existsSync(packed)) return packed;
    } else {
        // Dev: allow a repo-local copy.
        const devLocal = path.join(process.cwd(), "assets", "uv", UV_EXE);
        if (fs.existsSync(devLocal)) return devLocal;
    }
    const cached = path.join(pyenvDir(), "..", "uv", UV_EXE);
    if (fs.existsSync(cached)) return cached;
    return null;
}

/** uv release asset name for the current platform/arch. */
function uvAssetName(): string | null {
    const arch = process.arch;
    if (isWin) {
        if (arch === "x64") return "uv-x86_64-pc-windows-msvc.zip";
        if (arch === "arm64") return "uv-aarch64-pc-windows-msvc.zip";
        return null;
    }
    if (process.platform === "darwin") {
        return arch === "arm64" ? "uv-aarch64-apple-darwin.tar.gz" : "uv-x86_64-apple-darwin.tar.gz";
    }
    // linux
    if (arch === "x64") return "uv-x86_64-unknown-linux-gnu.tar.gz";
    if (arch === "arm64") return "uv-aarch64-unknown-linux-gnu.tar.gz";
    return null;
}

function download(url: string, dest: string, onPct?: (p: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { "User-Agent": "mmo-companion" } }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                download(res.headers.location, dest, onPct).then(resolve, reject);
                res.resume();
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`download ${url} → HTTP ${res.statusCode}`));
                res.resume();
                return;
            }
            const total = Number(res.headers["content-length"] || 0);
            let got = 0;
            const out = fs.createWriteStream(dest);
            res.on("data", (c) => {
                got += c.length;
                if (total && onPct) onPct(got / total);
            });
            res.pipe(out);
            out.on("finish", () => out.close((err) => (err ? reject(err) : resolve())));
            out.on("error", reject);
        });
        req.on("error", reject);
    });
}

/** Ensure `uv` is available; download the latest release into userData if not. */
async function ensureUv(onProgress: (p: EnvProgress) => void): Promise<string> {
    const existing = locateUv();
    if (existing) return existing;

    const asset = uvAssetName();
    if (!asset) throw new Error(`no uv build for ${process.platform}/${process.arch}`);

    const uvHome = path.join(pyenvDir(), "..", "uv");
    fs.mkdirSync(uvHome, { recursive: true });
    const url = `https://github.com/astral-sh/uv/releases/latest/download/${asset}`;
    const tmp = path.join(os.tmpdir(), `mmo-${asset}`);

    onProgress({ stage: "uv", pct: 0.05, msg: "Downloading package manager (uv)…" });
    await download(url, tmp, (p) => onProgress({ stage: "uv", pct: 0.05 + p * 0.4, msg: `Downloading uv… ${Math.round(p * 100)}%` }));

    onProgress({ stage: "uv", pct: 0.5, msg: "Extracting uv…" });
    await extractArchive(tmp, uvHome);
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }

    const found = locateUv();
    if (!found) throw new Error("uv missing after extraction");
    if (!isWin) { try { fs.chmodSync(found, 0o755); } catch { /* ignore */ } }
    return found;
}

/** Extract a .zip (win) or .tar.gz (unix) flattening any top-level dir so the
 *  uv binary lands directly in `destDir`. */
async function extractArchive(archive: string, destDir: string): Promise<void> {
    if (archive.endsWith(".zip")) {
        // Use PowerShell Expand-Archive on Windows (no extra deps).
        await run("powershell", [
            "-NoProfile", "-NonInteractive", "-Command",
            `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force`,
        ]);
        flattenInto(destDir, UV_EXE);
    } else {
        await run("tar", ["-xzf", archive, "-C", destDir]);
        flattenInto(destDir, UV_EXE);
    }
}

/** If `exe` ended up in a nested subdir, move it up to `dir`. */
function flattenInto(dir: string, exe: string): void {
    if (fs.existsSync(path.join(dir, exe))) return;
    const walk = (d: string): string | null => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { const r = walk(p); if (r) return r; }
            else if (e.name === exe) return p;
        }
        return null;
    };
    const found = walk(dir);
    if (found) fs.renameSync(found, path.join(dir, exe));
}

function run(cmd: string, args: string[], onLine?: (line: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { windowsHide: true });
        let stderr = "";
        const handle = (buf: Buffer) => {
            const s = buf.toString();
            stderr += s;
            if (onLine) for (const ln of s.split(/\r?\n/)) if (ln.trim()) onLine(ln.trim());
        };
        child.stdout?.on("data", handle);
        child.stderr?.on("data", handle);
        child.on("error", reject);
        child.on("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-500)}`)),
        );
    });
}

/**
 * Ensure a managed CPython 3.12 venv exists at {userData}/pyenv. Reuses an
 * existing one. Returns the venv python path. Idempotent + safe to call on
 * every launch.
 */
export async function ensurePythonEnv(onProgress: (p: EnvProgress) => void): Promise<string> {
    const py = venvPython();
    if (venvReady()) {
        onProgress({ stage: "done", pct: 1, msg: "Python environment ready." });
        return py;
    }

    const uv = await ensureUv(onProgress);

    onProgress({ stage: "python", pct: 0.55, msg: `Fetching Python ${PYTHON_VERSION}…` });
    // `uv venv` auto-downloads a managed CPython if needed. `--seed` installs
    // pip/setuptools into the venv so the analyzer's `python -m pip` works.
    await run(
        uv,
        ["venv", "--seed", "--python", PYTHON_VERSION, pyenvDir()],
        (ln) => {
            pushDebugLog("info", `[pyenv] ${ln}`);
            onProgress({ stage: "venv", pct: 0.8, msg: ln.slice(0, 120) });
        },
    );

    if (!venvReady()) throw new Error("venv creation reported success but python is missing");
    onProgress({ stage: "done", pct: 1, msg: "Python environment ready." });
    pushDebugLog("info", `[pyenv] ready at ${py}`);
    return py;
}

/** Path to the uv binary (for pip operations via `uv pip`). null if absent. */
export function uvPath(): string | null {
    return locateUv();
}
