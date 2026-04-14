"use server";

import { db } from "@/db";
import { tracks } from "@/db/schema";
import { generateRekordboxXml } from "@/lib/rekordbox-xml";
import { sql } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";

export async function exportRekordboxXml(outputPath?: string) {
  const allTracks = db
    .select()
    .from(tracks)
    .orderBy(sql`${tracks.genre}, ${tracks.artist}, ${tracks.title}`)
    .all();

  // Group tracks by genre for playlists
  const genreMap = new Map<string, number[]>();
  for (const track of allTracks) {
    const genre = track.genre || "Uncategorized";
    if (!genreMap.has(genre)) {
      genreMap.set(genre, []);
    }
    genreMap.get(genre)!.push(track.id);
  }

  const playlists = Array.from(genreMap.entries()).map(
    ([name, trackIds]) => ({
      name,
      trackIds,
    })
  );

  const xml = generateRekordboxXml(allTracks, playlists);

  const output =
    outputPath || path.join(process.cwd(), "data", "rekordbox-export.xml");

  fs.writeFileSync(output, xml, "utf-8");

  return {
    success: true,
    path: output,
    trackCount: allTracks.length,
    playlistCount: playlists.length,
  };
}
