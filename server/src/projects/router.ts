/**
 * Companion-side router for project asset blobs.
 *
 *   POST /projects/assets/upload
 *     Body: { sha256, name, mimeType?, bytes (base64) }
 *     Stores under `{userData}/project-assets/{sha[:2]}/{sha}`.
 *     Returns: { sha256, path, size }
 *
 *   GET /projects/assets/:sha256
 *     Streams the previously uploaded blob.
 *
 *   POST /projects/assets/register-local
 *     Body: { sha256, name, sourcePath }
 *     Registers an existing local file (e.g. a recording on disk)
 *     under its sha256 without copying bytes — useful for recordings
 *     captured by the companion itself.
 *
 * Auth: existing device-token middleware (same as /v1/sync).
 *
 * NOTE: this router intentionally does NOT call the cloud `registerAsset`
 * server action — the web side does that after a successful upload so
 * the asset row in cloud Postgres carries both the GCS key (if any) and
 * the companion id/path. Keeping the duties split avoids the companion
 * needing cloud auth credentials.
 */

import { Router, type RequestHandler } from "express";
import { app as electronApp } from "electron";
import { promises as fs, createReadStream, statSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ASSET_ROOT = () => path.join(electronApp.getPath("userData"), "project-assets");

function shaToPath(sha256: string): string {
    if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("bad sha256");
    const prefix = sha256.slice(0, 2);
    return path.join(ASSET_ROOT(), prefix, sha256);
}

export function createProjectsRouter(authMiddleware: RequestHandler): Router {
    const r = Router();
    r.use(authMiddleware);

    r.post("/assets/upload", async (req, res) => {
        try {
            const { sha256, name, bytes } = req.body as {
                sha256?: string;
                name?: string;
                mimeType?: string;
                bytes?: string;
            };
            if (!sha256 || !name || !bytes) {
                return res.status(400).json({ error: "sha256, name, bytes required" });
            }
            const buf = Buffer.from(bytes, "base64");
            const actualSha = crypto.createHash("sha256").update(buf).digest("hex");
            if (actualSha.toLowerCase() !== sha256.toLowerCase()) {
                return res.status(400).json({ error: "sha256 mismatch", expected: sha256, actual: actualSha });
            }
            const dest = shaToPath(sha256);
            await fs.mkdir(path.dirname(dest), { recursive: true });
            // Skip write if file already exists (content-addressed).
            try {
                const st = await fs.stat(dest);
                return res.json({ sha256, path: dest, size: st.size, deduped: true });
            } catch {
                /* not yet present — fall through */
            }
            await fs.writeFile(dest, buf);
            return res.json({ sha256, path: dest, size: buf.length });
        } catch (e) {
            return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    r.get("/assets/:sha256", (req, res) => {
        try {
            const sha = String(req.params.sha256 ?? "");
            const filePath = shaToPath(sha);
            const stat = statSync(filePath);
            res.setHeader("Content-Length", String(stat.size));
            res.setHeader("Content-Type", "application/octet-stream");
            res.setHeader("X-Content-Sha256", sha);
            createReadStream(filePath).pipe(res);
        } catch {
            res.status(404).json({ error: "not found" });
        }
    });

    r.post("/assets/register-local", async (req, res) => {
        try {
            const { sourcePath, sha256: providedSha } = req.body as {
                sourcePath?: string;
                sha256?: string;
                name?: string;
            };
            if (!sourcePath) return res.status(400).json({ error: "sourcePath required" });
            const buf = await fs.readFile(sourcePath);
            const sha = crypto.createHash("sha256").update(buf).digest("hex");
            if (providedSha && providedSha.toLowerCase() !== sha) {
                return res.status(400).json({ error: "sha256 mismatch" });
            }
            const dest = shaToPath(sha);
            await fs.mkdir(path.dirname(dest), { recursive: true });
            try { await fs.access(dest); }
            catch { await fs.copyFile(sourcePath, dest); }
            return res.json({ sha256: sha, path: dest, size: buf.length });
        } catch (e) {
            return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        }
    });

    return r;
}
