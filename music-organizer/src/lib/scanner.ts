import fs from "node:fs";
import path from "node:path";
import { AUDIO_EXTENSIONS } from "./utils";
import { readAudioMetadata } from "./audio";
import type { NewTrack } from "@/db/schema";

export interface ScanResult {
    tracks: NewTrack[];
    errors: string[];
    totalFiles: number;
    audioFiles: number;
}

export async function scanFolder(
    folderPath: string,
    recursive: boolean = true
): Promise<ScanResult> {
    const result: ScanResult = {
        tracks: [],
        errors: [],
        totalFiles: 0,
        audioFiles: 0,
    };

    if (!fs.existsSync(folderPath)) {
        result.errors.push(`Folder not found: ${folderPath}`);
        return result;
    }

    const files = getAudioFiles(folderPath, recursive);
    result.totalFiles = files.length;

    for (const file of files) {
        result.audioFiles++;
        try {
            const track = await readAudioMetadata(file);
            if (track) {
                result.tracks.push(track);
            } else {
                result.errors.push(`Could not read: ${file}`);
            }
        } catch (err) {
            result.errors.push(
                `Error scanning ${file}: ${err instanceof Error ? err.message : "Unknown error"}`
            );
        }
    }

    return result;
}

function getAudioFiles(dir: string, recursive: boolean): string[] {
    const files: string[] = [];

    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory() && recursive) {
                // Skip hidden folders and system folders
                if (entry.name.startsWith(".") || entry.name === "node_modules") {
                    continue;
                }
                files.push(...getAudioFiles(fullPath, recursive));
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (AUDIO_EXTENSIONS.has(ext)) {
                    files.push(fullPath);
                }
            }
        }
    } catch (err) {
        console.error(`Error reading directory ${dir}:`, err);
    }

    return files;
}
