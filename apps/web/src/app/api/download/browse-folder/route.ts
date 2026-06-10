import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { requireSessionWithRate } from "@/lib/api-guard";

export async function POST(request: NextRequest) {
    // Filesystem reads must be authenticated — this endpoint exposes
    // the entire host filesystem (drive letters on Windows). Rate-limit
    // to keep curiosity-pokes from enumerating a tree.
    const guard = await requireSessionWithRate(request, { bucket: "browse-folder", windowMs: 60_000, max: 60 });
    if (guard.response) return guard.response;
    try {
        const body = await request.json();
        const { dir } = body as { dir?: string };

        // Length + control-char gate. Without this, a multi-MB `dir`
        // string traverses path.resolve / fs.readdirSync with no upper
        // bound; control bytes also get accepted into log lines.
        if (typeof dir === "string" && (dir.length > 4096 || /[\x00-\x1F]/.test(dir))) {
            return NextResponse.json({ error: "Invalid dir" }, { status: 400 });
        }

        const target = dir || os.homedir();
        const resolved = path.resolve(target);

        if (!fs.existsSync(resolved)) {
            return NextResponse.json({ error: "Directory not found" }, { status: 404 });
        }

        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
            return NextResponse.json({ error: "Not a directory" }, { status: 400 });
        }

        const entries: { name: string; path: string; isDir: boolean }[] = [];

        try {
            const items = fs.readdirSync(resolved, { withFileTypes: true });
            for (const item of items) {
                // Skip hidden files/folders and system folders
                if (item.name.startsWith(".") || item.name.startsWith("$")) continue;
                if (item.isDirectory()) {
                    entries.push({
                        name: item.name,
                        path: path.join(resolved, item.name),
                        isDir: true,
                    });
                }
            }
        } catch {
            // Permission denied — return empty list
        }

        // Sort directories alphabetically
        entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

        // Get parent
        const parent = path.dirname(resolved);
        const hasParent = parent !== resolved;

        // Get drive roots on Windows
        let drives: string[] | undefined;
        if (os.platform() === "win32") {
            drives = [];
            for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
                const drivePath = `${letter}:\\`;
                try {
                    if (fs.existsSync(drivePath)) drives.push(drivePath);
                } catch { /* skip */ }
            }
        }

        return NextResponse.json({
            current: resolved,
            parent: hasParent ? parent : null,
            entries,
            drives,
        });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "Failed to browse" },
            { status: 500 }
        );
    }
}

export async function PUT(request: NextRequest) {
    const guard = await requireSessionWithRate(request, { bucket: "mkdir", windowMs: 60_000, max: 20 });
    if (guard.response) return guard.response;
    try {
        const body = await request.json();
        const { dir, name } = body as { dir?: string; name?: string };

        if (!dir || !name) {
            return NextResponse.json({ error: "Missing dir or name" }, { status: 400 });
        }

        // Sanitize folder name — prevent path traversal
        const sanitized = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim();
        if (!sanitized || sanitized === "." || sanitized === "..") {
            return NextResponse.json({ error: "Invalid folder name" }, { status: 400 });
        }

        const resolved = path.resolve(dir);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            return NextResponse.json({ error: "Parent directory not found" }, { status: 404 });
        }

        const newPath = path.join(resolved, sanitized);
        if (fs.existsSync(newPath)) {
            return NextResponse.json({ error: "Folder already exists" }, { status: 409 });
        }

        fs.mkdirSync(newPath, { recursive: true });

        return NextResponse.json({ created: newPath });
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "Failed to create folder" },
            { status: 500 }
        );
    }
}
