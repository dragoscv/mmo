// Structural type — keeps this helper independent of where the track row
// physically lives (was @/db/schema, now @/lib/companion-library).
export interface RekordboxXmlTrack {
    id: number;
    filepath: string;
    filename: string;
    title: string | null;
    artist: string | null;
    album: string | null;
    genre: string | null;
    keyMusical: string | null;
    bpm: number | null;
    duration: number | null;
    bitrate: number | null;
    sampleRate: number | null;
    energy: number | null;
    mood: string | null;
    setPosition: string | null;
    color: string | null;
}

type Track = RekordboxXmlTrack;

export function generateRekordboxXml(
    tracks: Track[],
    playlists?: { name: string; trackIds: number[] }[]
): string {
    const collection = tracks
        .map((t, i) => {
            const location = `file://localhost/${t.filepath.replace(/\\/g, "/")}`
                .replace(/ /g, "%20");

            const attrs = [
                `TrackID="${i + 1}"`,
                `Name="${escapeXml(t.title || t.filename)}"`,
                `Artist="${escapeXml(t.artist || "")}"`,
                `Album="${escapeXml(t.album || "")}"`,
                `Genre="${escapeXml(t.genre || "")}"`,
                `Tonality="${escapeXml(t.keyMusical || "")}"`,
                `AverageBpm="${(t.bpm || 0).toFixed(2)}"`,
                `TotalTime="${t.duration || 0}"`,
                `Location="${location}"`,
                `BitRate="${t.bitrate || 0}"`,
                `SampleRate="${t.sampleRate || 0}"`,
                `Rating="${(t.energy || 0) * 51}"`,
                `Comments="${escapeXml(buildComment(t))}"`,
            ];

            return `    <TRACK ${attrs.join(" ")} />`;
        })
        .join("\n");

    // Build track ID lookup
    const trackIdMap = new Map<number, number>();
    tracks.forEach((t, i) => {
        trackIdMap.set(t.id, i + 1);
    });

    // Build playlist nodes
    let playlistXml = "";
    if (playlists && playlists.length > 0) {
        const playlistNodes = playlists
            .map((p) => {
                const trackEntries = p.trackIds
                    .filter((id) => trackIdMap.has(id))
                    .map((id) => `          <TRACK Key="${trackIdMap.get(id)}" />`)
                    .join("\n");
                return `        <NODE Type="1" Name="${escapeXml(p.name)}" KeyType="0" Entries="${p.trackIds.length}">\n${trackEntries}\n        </NODE>`;
            })
            .join("\n");

        playlistXml = `
    <NODE Type="0" Name="ROOT" Count="${playlists.length}">
${playlistNodes}
    </NODE>`;
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.0.0" Company="AlphaTheta" />
  <COLLECTION Entries="${tracks.length}">
${collection}
  </COLLECTION>
  <PLAYLISTS>${playlistXml}
  </PLAYLISTS>
</DJ_PLAYLISTS>`;
}

function escapeXml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function buildComment(track: Track): string {
    const parts: string[] = [];
    if (track.energy) parts.push(`E${track.energy}`);
    if (track.mood) parts.push(track.mood);
    if (track.setPosition) parts.push(track.setPosition);
    if (track.color) parts.push(track.color);
    return parts.join(" | ");
}
