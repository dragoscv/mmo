import { parseFile } from "music-metadata";
import path from "node:path";
import fs from "node:fs";
import type { NewTrack } from "@/db/schema";
import { suggestGenre } from "./genre-suggest";
import { musicalKeyToCamelot } from "./genre-suggest";

export async function readAudioMetadata(
  filepath: string
): Promise<NewTrack | null> {
  try {
    if (!fs.existsSync(filepath)) return null;

    const stats = fs.statSync(filepath);
    const metadata = await parseFile(filepath);
    const ext = path.extname(filepath).toLowerCase().replace(".", "");
    const filename = path.basename(filepath);

    const { common, format } = metadata;

    const bpm = common.bpm ?? null;
    const keyMusical = common.key ?? null;
    const keyCamelot = keyMusical ? musicalKeyToCamelot(keyMusical) : null;
    const duration = format.duration ? Math.round(format.duration) : null;
    const genre = common.genre?.[0] ?? (bpm ? suggestGenre(bpm) : null);

    // Try to parse artist - title from filename if not in tags
    let artist = common.artist ?? null;
    let title = common.title ?? null;

    if (!artist || !title) {
      const parsed = parseFilename(filename);
      artist = artist || parsed.artist;
      title = title || parsed.title;
    }

    return {
      filepath,
      filename,
      artist,
      title,
      album: common.album ?? null,
      remix: null,
      label: common.label?.[0] ?? null,
      bpm: bpm ?? null,
      keyCamelot: keyCamelot,
      keyMusical: keyMusical,
      duration,
      energy: null,
      genre: genre ?? null,
      subgenre: null,
      mood: null,
      color: null,
      vocalType: null,
      setPosition: null,
      mixability: null,
      isProcessed: false,
      fileSize: stats.size,
      format: ext,
      bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : null,
      sampleRate: format.sampleRate ?? null,
      analyzedAt: new Date().toISOString(),
    };
  } catch {
    console.error(`Failed to read metadata for: ${filepath}`);
    return null;
  }
}

function parseFilename(filename: string): {
  artist: string | null;
  title: string | null;
} {
  const name = filename.replace(/\.[^.]+$/, "");

  // Pattern: "Artist - Title (Remix) [Label]"
  const match = name.match(/^(.+?)\s*[-–—]\s*(.+?)(?:\s*[\[(].*)?$/);
  if (match) {
    return { artist: match[1].trim(), title: match[2].trim() };
  }

  return { artist: null, title: name.trim() };
}
