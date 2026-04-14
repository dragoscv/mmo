const MB_BASE = "https://musicbrainz.org/ws/2";
const CAA_BASE = "https://coverartarchive.org";
const USER_AGENT = "MusicOrganizer/1.0 (https://github.com/music-organizer)";

// Rate limiter: 1 request per second for MusicBrainz
let lastRequestTime = 0;
async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < 1100) {
    await new Promise((r) => setTimeout(r, 1100 - timeSinceLastRequest));
  }
  lastRequestTime = Date.now();
  return fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });
}

export interface MBRecording {
  id: string;
  title: string;
  score: number;
  length?: number;
  "artist-credit"?: Array<{
    name: string;
    artist: { id: string; name: string };
  }>;
  releases?: Array<{
    id: string;
    title: string;
    date?: string;
    "release-group"?: {
      id: string;
      "primary-type"?: string;
    };
    "label-info"?: Array<{
      label?: { id: string; name: string };
      "catalog-number"?: string;
    }>;
  }>;
  tags?: Array<{ name: string; count: number }>;
  genres?: Array<{ name: string; count: number }>;
}

export interface MBSearchResult {
  recordings: MBRecording[];
  count: number;
}

export interface TrackMetadata {
  title?: string;
  artist?: string;
  album?: string;
  label?: string;
  year?: number;
  genre?: string;
  bpm?: number;
  duration?: number;
  musicbrainzId?: string;
  releaseMbid?: string;
  artworkUrl?: string;
  tags?: string[];
}

export async function searchRecordings(
  artist: string,
  title: string,
  limit = 5
): Promise<MBRecording[]> {
  const query = [];
  if (artist) query.push(`artist:"${encodeURIComponent(artist)}"`);
  if (title) query.push(`recording:"${encodeURIComponent(title)}"`);
  if (query.length === 0) return [];

  const url = `${MB_BASE}/recording?query=${query.join(" AND ")}&fmt=json&limit=${limit}`;
  try {
    const res = await rateLimitedFetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as MBSearchResult;
    return data.recordings || [];
  } catch {
    return [];
  }
}

export async function lookupRecording(
  mbid: string
): Promise<MBRecording | null> {
  const url = `${MB_BASE}/recording/${mbid}?inc=releases+artists+tags+genres+label-rels&fmt=json`;
  try {
    const res = await rateLimitedFetch(url);
    if (!res.ok) return null;
    return (await res.json()) as MBRecording;
  } catch {
    return null;
  }
}

export async function getArtworkUrl(
  releaseMbid: string
): Promise<string | null> {
  try {
    // Cover Art Archive will redirect to the actual image
    const res = await fetch(`${CAA_BASE}/release/${releaseMbid}/front-500`, {
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT },
    });
    // The redirect URL is the actual image URL
    if (res.status === 307 || res.status === 302) {
      return res.headers.get("location");
    }
    if (res.ok) {
      return `${CAA_BASE}/release/${releaseMbid}/front-500`;
    }
    return null;
  } catch {
    return null;
  }
}

export function extractMetadata(recording: MBRecording): TrackMetadata {
  const metadata: TrackMetadata = {
    title: recording.title,
    musicbrainzId: recording.id,
  };

  // Artist
  if (recording["artist-credit"]?.length) {
    metadata.artist = recording["artist-credit"]
      .map((ac) => ac.name)
      .join(", ");
  }

  // Duration in seconds
  if (recording.length) {
    metadata.duration = Math.round(recording.length / 1000);
  }

  // Best release (prefer album, then single, then any)
  const releases = recording.releases || [];
  const bestRelease =
    releases.find(
      (r) => r["release-group"]?.["primary-type"] === "Album"
    ) ||
    releases.find(
      (r) => r["release-group"]?.["primary-type"] === "Single"
    ) ||
    releases[0];

  if (bestRelease) {
    metadata.album = bestRelease.title;
    metadata.releaseMbid = bestRelease.id;

    if (bestRelease.date) {
      const yearMatch = bestRelease.date.match(/^(\d{4})/);
      if (yearMatch) metadata.year = parseInt(yearMatch[1]);
    }

    const labelInfo = bestRelease["label-info"];
    if (labelInfo?.length && labelInfo[0].label) {
      metadata.label = labelInfo[0].label.name;
    }
  }

  // Tags/genres
  const allTags = [
    ...(recording.tags || []),
    ...(recording.genres || []),
  ]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((t) => t.name);

  if (allTags.length > 0) {
    metadata.tags = allTags;
    // Use the most popular tag as genre if it looks like a genre
    metadata.genre = allTags[0];
  }

  return metadata;
}
