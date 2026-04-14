"use server";

import { db } from "@/db";
import { tracks } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  searchRecordings,
  lookupRecording,
  extractMetadata,
  getArtworkUrl,
  type TrackMetadata,
} from "@/lib/musicbrainz";

export interface MetadataSearchResult {
  id: string;
  title: string;
  artist: string;
  album?: string;
  label?: string;
  year?: number;
  score: number;
  releaseMbid?: string;
  artworkUrl?: string;
  tags?: string[];
}

export async function searchTrackMetadata(
  artist: string,
  title: string
): Promise<MetadataSearchResult[]> {
  const recordings = await searchRecordings(artist, title, 8);

  const results: MetadataSearchResult[] = [];
  for (const rec of recordings) {
    const meta = extractMetadata(rec);
    results.push({
      id: rec.id,
      title: rec.title,
      artist: meta.artist || "",
      album: meta.album,
      label: meta.label,
      year: meta.year,
      score: rec.score,
      releaseMbid: meta.releaseMbid,
      tags: meta.tags,
    });
  }

  return results;
}

export async function fetchAndApplyMetadata(
  trackId: number,
  mbRecordingId: string,
  fieldsToApply: string[]
): Promise<{ success: boolean; applied: TrackMetadata }> {
  const recording = await lookupRecording(mbRecordingId);
  if (!recording) {
    return { success: false, applied: {} };
  }

  const meta = extractMetadata(recording);

  // Fetch artwork if release MBID available
  if (meta.releaseMbid) {
    const artUrl = await getArtworkUrl(meta.releaseMbid);
    if (artUrl) meta.artworkUrl = artUrl;
  }

  // Build update object based on selected fields
  const update: Record<string, unknown> = {};
  if (fieldsToApply.includes("title") && meta.title) update.title = meta.title;
  if (fieldsToApply.includes("artist") && meta.artist)
    update.artist = meta.artist;
  if (fieldsToApply.includes("album") && meta.album) update.album = meta.album;
  if (fieldsToApply.includes("label") && meta.label) update.label = meta.label;
  if (fieldsToApply.includes("year") && meta.year) update.year = meta.year;
  if (fieldsToApply.includes("genre") && meta.genre) update.genre = meta.genre;
  if (fieldsToApply.includes("artwork") && meta.artworkUrl)
    update.artworkUrl = meta.artworkUrl;
  if (fieldsToApply.includes("tags") && meta.tags)
    update.tags = JSON.stringify(meta.tags);

  // Always store MusicBrainz IDs
  update.musicbrainzId = meta.musicbrainzId;
  if (meta.releaseMbid) update.releaseMbid = meta.releaseMbid;

  if (Object.keys(update).length > 0) {
    await db.update(tracks).set(update).where(eq(tracks.id, trackId));
  }

  return { success: true, applied: meta };
}

export async function fetchArtworkForTrack(
  trackId: number,
  releaseMbid: string
): Promise<{ success: boolean; artworkUrl?: string }> {
  const artUrl = await getArtworkUrl(releaseMbid);
  if (!artUrl) return { success: false };

  await db
    .update(tracks)
    .set({ artworkUrl: artUrl, releaseMbid })
    .where(eq(tracks.id, trackId));

  return { success: true, artworkUrl: artUrl };
}
