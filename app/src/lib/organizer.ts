import fs from "node:fs";
import path from "node:path";

export interface MoveResult {
    success: boolean;
    newPath: string;
    error?: string;
}

export function moveTrackToGenreFolder(
    currentPath: string,
    musicRoot: string,
    genreFolder: string
): MoveResult {
    try {
        if (!fs.existsSync(currentPath)) {
            return { success: false, newPath: currentPath, error: "File not found" };
        }

        const targetDir = path.join(musicRoot, genreFolder);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        const filename = path.basename(currentPath);
        let newPath = path.join(targetDir, filename);

        // Handle name conflicts
        if (fs.existsSync(newPath) && newPath !== currentPath) {
            const ext = path.extname(filename);
            const name = path.basename(filename, ext);
            let counter = 1;
            while (fs.existsSync(newPath)) {
                newPath = path.join(targetDir, `${name} (${counter})${ext}`);
                counter++;
            }
        }

        if (newPath === currentPath) {
            return { success: true, newPath };
        }

        fs.renameSync(currentPath, newPath);
        return { success: true, newPath };
    } catch (err) {
        return {
            success: false,
            newPath: currentPath,
            error: err instanceof Error ? err.message : "Unknown error",
        };
    }
}

export function renameTrack(
    currentPath: string,
    artist: string,
    title: string,
    remix?: string
): MoveResult {
    try {
        if (!fs.existsSync(currentPath)) {
            return { success: false, newPath: currentPath, error: "File not found" };
        }

        const ext = path.extname(currentPath);
        const dir = path.dirname(currentPath);

        let newName = `${sanitizeFilename(artist)} - ${sanitizeFilename(title)}`;
        if (remix) {
            newName += ` (${sanitizeFilename(remix)})`;
        }
        newName += ext;

        const newPath = path.join(dir, newName);

        if (newPath === currentPath) {
            return { success: true, newPath };
        }

        if (fs.existsSync(newPath)) {
            return {
                success: false,
                newPath: currentPath,
                error: "File with that name already exists",
            };
        }

        fs.renameSync(currentPath, newPath);
        return { success: true, newPath };
    } catch (err) {
        return {
            success: false,
            newPath: currentPath,
            error: err instanceof Error ? err.message : "Unknown error",
        };
    }
}

function sanitizeFilename(name: string): string {
    return name.replace(/[<>:"/\\|?*]/g, "").trim();
}
