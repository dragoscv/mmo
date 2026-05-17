import { XMLParser } from "fast-xml-parser";
import fs from "node:fs";
import path from "node:path";
import { musicalKeyToCamelot } from "./genre-suggest";

// Structural shape used by the rekordbox importer. Mirrors the columns
// the companion's library schema accepts via /library/tracks/ingest.
// Decoupled from any specific Drizzle schema so this lib can be reused
// by either the web app or the companion.
export interface ImportedTrackInput {
    filepath: string;
    filename: string;
    artist?: string;
    title?: string;
    album?: string;
    remix?: string;
    label?: string;
    bpm?: number;
    keyCamelot?: string;
    keyMusical?: string;
    duration?: number;
    energy?: number;
    genre?: string;
    mood?: string;
    color?: string;
    vocalType?: string;
    setPosition?: string;
    mixability?: number;
    isProcessed?: boolean;
    fileSize?: number;
    format?: string;
    bitrate?: number;
    sampleRate?: number;
}

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

export interface ImportedTrack extends ImportedTrackInput {
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

            const filename = path.win32.basename(filepath);
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

