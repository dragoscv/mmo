import { XMLParser } from "fast-xml-parser";
import fs from "node:fs";
import path from "node:path";
import { musicalKeyToCamelot } from "./genre-suggest";
import type { NewTrack } from "@/db/schema";
import { db } from "@/db";
import { tracks, playlists, playlistTracks } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

interface RekordboxTrack {
    TrackID: number;
    Name: string;
    Artist: string;
    Album: string;
    Genre: string;
    Kind: string;
    Size: number;
    TotalTime: number;
    AverageBpm: number;
    DateAdded: string;
    BitRate: number;
    SampleRate: number;
    Comments: string;
    PlayCount: number;
    Rating: number;
    Location: string;
    Remixer: string;
    Tonality: string;
    Label: string;
    Mix: string;
    Colour: string;
    Year: number;
}

interface RekordboxPlaylistNode {
    Type: number; // 0 = folder, 1 = playlist
    Name: string;
    Count?: number;
    Entries?: number;
    KeyType?: number;
    NODE?: RekordboxPlaylistNode | RekordboxPlaylistNode[];
    TRACK?: { Key: number } | { Key: number }[];
}

export interface ImportedTrack extends NewTrack {
    rekordboxId: number;
    playCount: number;
    dateAdded: string;
}

export interface ImportedPlaylist {
    name: string;
    path: string; // "Folder/Subfolder/Playlist"
    trackIds: number[]; // rekordbox TrackIDs
}

export interface RekordboxImportResult {
    tracks: ImportedTrack[];
    playlists: ImportedPlaylist[];
    errors: string[];
}

function decodeRekordboxLocation(location: string): string {
    // rekordbox uses file://localhost/C:/path/to/file.mp3
    let filepath = location
        .replace("file://localhost/", "")
        .replace(/%20/g, " ");

    // Decode any remaining percent-encoded characters
    try {
        filepath = decodeURIComponent(filepath);
    } catch {
        // Already decoded or invalid encoding
    }

    // Convert forward slashes to backslashes on Windows
    filepath = filepath.replace(/\//g, "\\");

    return filepath;
}

function ratingToEnergy(rating: number): number | undefined {
    if (!rating || rating === 0) return undefined;
    // Rekordbox: 0=none, 51=1star, 102=2stars, 153=3stars, 204=4stars, 255=5stars
    const energy = Math.round(rating / 51);
    return Math.max(1, Math.min(5, energy));
}

function parseRekordboxColor(colour: string | number): string | undefined {
    if (!colour) return undefined;
    // Rekordbox colour can be a hex string like "0xFF0000" or a number
    if (typeof colour === "number") {
        // Rekordbox uses color IDs: 1=pink, 2=red, 3=orange, 4=yellow, 5=green, 6=aqua, 7=blue, 8=purple
        const colorMap: Record<number, string> = {
            1: "Pink",
            2: "Red",
            3: "Orange",
            4: "Yellow",
            5: "Green",
            6: "Aqua",
            7: "Blue",
            8: "Purple",
        };
        return colorMap[colour];
    }
    return String(colour);
}

export function parseRekordboxXml(xmlPath: string): RekordboxImportResult {
    const errors: string[] = [];

    if (!fs.existsSync(xmlPath)) {
        return { tracks: [], playlists: [], errors: [`File not found: ${xmlPath}`] };
    }

    const xmlContent = fs.readFileSync(xmlPath, "utf-8");

    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "",
        parseAttributeValue: true,
        isArray: (name) => name === "NODE" || name === "TRACK",
    });

    let parsed: Record<string, unknown>;
    try {
        parsed = parser.parse(xmlContent);
    } catch (e) {
        return {
            tracks: [],
            playlists: [],
            errors: [`XML parse error: ${e instanceof Error ? e.message : String(e)}`],
        };
    }

    const djPlaylists = parsed.DJ_PLAYLISTS as Record<string, unknown>;
    if (!djPlaylists) {
        return { tracks: [], playlists: [], errors: ["Invalid rekordbox XML: missing DJ_PLAYLISTS root"] };
    }

    // Parse tracks from COLLECTION
    const collection = djPlaylists.COLLECTION as Record<string, unknown>;
    const rawTracks: RekordboxTrack[] = [];

    if (collection) {
        const trackEntries = collection.TRACK;
        const trackArray = Array.isArray(trackEntries)
            ? trackEntries
            : trackEntries
                ? [trackEntries]
                : [];

        for (const t of trackArray as RekordboxTrack[]) {
            rawTracks.push(t);
        }
    }

    // Convert to our track format
    const tracks: ImportedTrack[] = [];
    for (const rt of rawTracks) {
        try {
            const filepath = decodeRekordboxLocation(String(rt.Location || ""));
            if (!filepath) continue;

            const filename = path.basename(filepath);
            const tonality = String(rt.Tonality || "");
            const camelot = tonality ? musicalKeyToCamelot(tonality) : undefined;

            tracks.push({
                rekordboxId: rt.TrackID,
                filepath,
                filename,
                artist: String(rt.Artist || "") || undefined,
                title: String(rt.Name || "") || undefined,
                album: String(rt.Album || "") || undefined,
                remix: String(rt.Remixer || "") || undefined,
                label: String(rt.Label || "") || undefined,
                bpm: rt.AverageBpm || undefined,
                keyCamelot: camelot || undefined,
                keyMusical: tonality || undefined,
                duration: rt.TotalTime || undefined,
                energy: ratingToEnergy(rt.Rating),
                genre: String(rt.Genre || "") || undefined,
                mood: undefined,
                color: parseRekordboxColor(rt.Colour),
                vocalType: undefined,
                setPosition: undefined,
                mixability: undefined,
                isProcessed: !!(rt.AverageBpm && tonality),
                fileSize: rt.Size || undefined,
                format: String(rt.Kind || "")
                    .replace(" File", "")
                    .trim() || undefined,
                bitrate: rt.BitRate || undefined,
                sampleRate: rt.SampleRate || undefined,
                playCount: rt.PlayCount || 0,
                dateAdded: String(rt.DateAdded || ""),
            });
        } catch (e) {
            errors.push(
                `Track parse error (ID ${rt.TrackID}): ${e instanceof Error ? e.message : String(e)}`
            );
        }
    }

    // Parse playlists
    const playlists: ImportedPlaylist[] = [];
    const playlistsNode = djPlaylists.PLAYLISTS as Record<string, unknown>;

    if (playlistsNode) {
        const rootNodes = playlistsNode.NODE;
        const rootArray = Array.isArray(rootNodes)
            ? rootNodes
            : rootNodes
                ? [rootNodes]
                : [];

        for (const node of rootArray as RekordboxPlaylistNode[]) {
            extractPlaylists(node, "", playlists);
        }
    }

    return { tracks, playlists, errors };
}

function extractPlaylists(
    node: RekordboxPlaylistNode,
    parentPath: string,
    result: ImportedPlaylist[]
) {
    const currentPath = parentPath
        ? `${parentPath}/${node.Name}`
        : node.Name;

    if (node.Type === 1) {
        // It's a playlist
        const trackRefs = node.TRACK;
        const trackArray = Array.isArray(trackRefs)
            ? trackRefs
            : trackRefs
                ? [trackRefs]
                : [];

        result.push({
            name: node.Name,
            path: currentPath,
            trackIds: trackArray.map((t) => t.Key),
        });
    }

    // Recurse into child nodes (folders or nested playlists)
    if (node.NODE) {
        const children = Array.isArray(node.NODE) ? node.NODE : [node.NODE];
        for (const child of children) {
            extractPlaylists(child, node.Name === "ROOT" ? "" : currentPath, result);
        }
    }
}

/**
 * Find the rekordbox XML file in common locations
 */
export function findRekordboxXml(): string | null {
    const homeDir = process.env.USERPROFILE || process.env.HOME || "";

    const commonPaths = [
        path.join(homeDir, "AppData", "Roaming", "Pioneer", "rekordbox", "rekordbox.xml"),
        path.join(homeDir, "AppData", "Roaming", "Pioneer", "rekordbox6", "rekordbox.xml"),
        path.join(homeDir, "Documents", "rekordbox.xml"),
        path.join(homeDir, "Music", "rekordbox.xml"),
        // macOS paths (just in case)
        path.join(homeDir, "Library", "Pioneer", "rekordbox", "rekordbox.xml"),
    ];

    for (const p of commonPaths) {
        if (fs.existsSync(p)) return p;
    }

    return null;
}

/**
 * Chunked import for large XML files.
 * Reads the XML as text, extracts TRACK elements with regex,
 * parses them in batches, and uses SQLite transactions for speed.
 */
export function importLargeRekordboxXml(
    xmlPath: string,
    onProgress?: (imported: number, total: number) => void
): RekordboxImportResult {
    const errors: string[] = [];

    if (!fs.existsSync(xmlPath)) {
        return { tracks: [], playlists: [], errors: [`File not found: ${xmlPath}`] };
    }

    // Read file - even large files can be read as text since we're on a server with enough memory
    // The key optimization is batched DB inserts with transactions
    let xmlContent: string;
    try {
        xmlContent = fs.readFileSync(xmlPath, "utf-8");
    } catch (e) {
        return {
            tracks: [],
            playlists: [],
            errors: [`Failed to read file: ${e instanceof Error ? e.message : String(e)}`],
        };
    }

    // Extract track elements using regex for memory-efficient processing
    const trackRegex = /<TRACK\s[^>]*\/>/g;
    const trackElements: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = trackRegex.exec(xmlContent)) !== null) {
        trackElements.push(match[0]);
    }

    // Also handle multi-line TRACK elements (with child elements like TEMPO, POSITION_MARK)
    const trackBlockRegex = /<TRACK\s[^>]*>[\s\S]*?<\/TRACK>/g;
    while ((match = trackBlockRegex.exec(xmlContent)) !== null) {
        trackElements.push(match[0]);
    }

    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "",
        parseAttributeValue: true,
    });

    // Process tracks and insert in batches using a transaction
    const importedTracks: ImportedTrack[] = [];
    const rekordboxIdToDbId = new Map<number, number>();
    let imported = 0;
    let updated = 0;

    const BATCH_SIZE = 500;

    // Prepare all tracks first
    for (let i = 0; i < trackElements.length; i++) {
        try {
            const parsed = parser.parse(trackElements[i]);
            const rt = parsed.TRACK as RekordboxTrack;
            if (!rt || !rt.Location) continue;

            const filepath = decodeRekordboxLocation(String(rt.Location || ""));
            if (!filepath) continue;

            const filename = path.basename(filepath);
            const tonality = String(rt.Tonality || "");
            const camelot = tonality ? musicalKeyToCamelot(tonality) : undefined;

            importedTracks.push({
                rekordboxId: rt.TrackID,
                filepath,
                filename,
                artist: String(rt.Artist || "") || undefined,
                title: String(rt.Name || "") || undefined,
                album: String(rt.Album || "") || undefined,
                remix: String(rt.Remixer || "") || undefined,
                label: String(rt.Label || "") || undefined,
                bpm: rt.AverageBpm || undefined,
                keyCamelot: camelot || undefined,
                keyMusical: tonality || undefined,
                duration: rt.TotalTime || undefined,
                energy: ratingToEnergy(rt.Rating),
                genre: String(rt.Genre || "") || undefined,
                mood: undefined,
                color: parseRekordboxColor(rt.Colour),
                vocalType: undefined,
                setPosition: undefined,
                mixability: undefined,
                isProcessed: !!(rt.AverageBpm && tonality),
                fileSize: rt.Size || undefined,
                format: String(rt.Kind || "")
                    .replace(" File", "")
                    .trim() || undefined,
                bitrate: rt.BitRate || undefined,
                sampleRate: rt.SampleRate || undefined,
                playCount: rt.PlayCount || 0,
                dateAdded: String(rt.DateAdded || ""),
            });
        } catch (e) {
            errors.push(`Track parse error: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // Batch insert/update using raw SQL transaction for speed
    const sqlite = (db as unknown as { $client: { exec: (sql: string) => void; prepare: (sql: string) => { run: (...args: unknown[]) => void; get: (...args: unknown[]) => Record<string, unknown> | undefined } } }).$client;

    // Process in batches
    for (let batchStart = 0; batchStart < importedTracks.length; batchStart += BATCH_SIZE) {
        const batch = importedTracks.slice(batchStart, batchStart + BATCH_SIZE);

        sqlite.exec("BEGIN TRANSACTION");
        try {
            const checkStmt = sqlite.prepare("SELECT id FROM tracks WHERE filepath = ?");
            const insertStmt = sqlite.prepare(
                `INSERT INTO tracks (filepath, filename, artist, title, album, remix, label, bpm, key_camelot, key_musical, duration, energy, genre, mood, color, vocal_type, set_position, mixability, is_processed, file_size, format, bitrate, sample_rate, analyzed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
            );
            const updateStmt = sqlite.prepare(
                `UPDATE tracks SET bpm = COALESCE(?, bpm), key_camelot = COALESCE(?, key_camelot), key_musical = COALESCE(?, key_musical), energy = COALESCE(?, energy), genre = COALESCE(?, genre), color = COALESCE(?, color), label = COALESCE(?, label), album = COALESCE(?, album), remix = COALESCE(?, remix), artist = COALESCE(?, artist), title = COALESCE(?, title) WHERE id = ?`
            );

            for (const track of batch) {
                const { rekordboxId, playCount, dateAdded, ...trackData } = track;

                const existing = checkStmt.get(trackData.filepath) as { id: number } | undefined;

                if (existing) {
                    updateStmt.run(
                        trackData.bpm ?? null, trackData.keyCamelot ?? null, trackData.keyMusical ?? null,
                        trackData.energy ?? null, trackData.genre ?? null, trackData.color ?? null,
                        trackData.label ?? null, trackData.album ?? null, trackData.remix ?? null,
                        trackData.artist ?? null, trackData.title ?? null, existing.id
                    );
                    updated++;
                    rekordboxIdToDbId.set(rekordboxId, existing.id);
                } else {
                    const result = insertStmt.get(
                        trackData.filepath, trackData.filename, trackData.artist ?? null,
                        trackData.title ?? null, trackData.album ?? null, trackData.remix ?? null,
                        trackData.label ?? null, trackData.bpm ?? null, trackData.keyCamelot ?? null,
                        trackData.keyMusical ?? null, trackData.duration ?? null, trackData.energy ?? null,
                        trackData.genre ?? null, trackData.mood ?? null, trackData.color ?? null,
                        trackData.vocalType ?? null, trackData.setPosition ?? null, trackData.mixability ?? null,
                        trackData.isProcessed ? 1 : 0, trackData.fileSize ?? null, trackData.format ?? null,
                        trackData.bitrate ?? null, trackData.sampleRate ?? null, new Date().toISOString()
                    ) as { id: number } | undefined;
                    if (result) {
                        imported++;
                        rekordboxIdToDbId.set(rekordboxId, result.id);
                    }
                }
            }
            sqlite.exec("COMMIT");
        } catch (e) {
            sqlite.exec("ROLLBACK");
            errors.push(`Batch insert error: ${e instanceof Error ? e.message : String(e)}`);
        }

        onProgress?.(batchStart + batch.length, importedTracks.length);
    }

    // Parse playlists from the same XML
    const playlistResults: ImportedPlaylist[] = [];
    try {
        // Extract PLAYLISTS section
        const playlistsMatch = xmlContent.match(/<PLAYLISTS>[\s\S]*<\/PLAYLISTS>/);
        if (playlistsMatch) {
            const playlistParser = new XMLParser({
                ignoreAttributes: false,
                attributeNamePrefix: "",
                parseAttributeValue: true,
                isArray: (name) => name === "NODE" || name === "TRACK",
            });
            const playlistsParsed = playlistParser.parse(`<root>${playlistsMatch[0]}</root>`);
            const playlistsNode = playlistsParsed.root?.PLAYLISTS;

            if (playlistsNode) {
                const rootNodes = playlistsNode.NODE;
                const rootArray = Array.isArray(rootNodes) ? rootNodes : rootNodes ? [rootNodes] : [];
                for (const node of rootArray as RekordboxPlaylistNode[]) {
                    extractPlaylists(node, "", playlistResults);
                }
            }
        }
    } catch (e) {
        errors.push(`Playlist parse error: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Import playlists in a transaction
    let playlistsCreated = 0;
    if (playlistResults.length > 0) {
        sqlite.exec("BEGIN TRANSACTION");
        try {
            for (const pl of playlistResults) {
                const existingPl = db
                    .select()
                    .from(playlists)
                    .where(eq(playlists.name, pl.name))
                    .get();

                let playlistId: number;
                if (existingPl) {
                    playlistId = existingPl.id;
                    db.delete(playlistTracks)
                        .where(eq(playlistTracks.playlistId, playlistId))
                        .run();
                } else {
                    const result = db
                        .insert(playlists)
                        .values({ name: pl.name, description: pl.path, type: "rekordbox" })
                        .returning({ id: playlists.id })
                        .get();
                    playlistId = result.id;
                    playlistsCreated++;
                }

                let position = 0;
                for (const rkId of pl.trackIds) {
                    const dbTrackId = rekordboxIdToDbId.get(rkId);
                    if (dbTrackId) {
                        db.insert(playlistTracks)
                            .values({ playlistId, trackId: dbTrackId, position: position++ })
                            .run();
                    }
                }
            }
            sqlite.exec("COMMIT");
        } catch (e) {
            sqlite.exec("ROLLBACK");
            errors.push(`Playlist import error: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // Free memory
    xmlContent = "";

    return {
        tracks: [],
        playlists: [],
        errors: errors.slice(0, 20),
        _stats: {
            imported,
            updated,
            playlistsCreated,
            totalTracksProcessed: importedTracks.length,
            totalPlaylistsProcessed: playlistResults.length,
        },
    } as RekordboxImportResult & { _stats: { imported: number; updated: number; playlistsCreated: number; totalTracksProcessed: number; totalPlaylistsProcessed: number } };
}
