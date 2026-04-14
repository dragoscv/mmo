"use server";

import { importLargeRekordboxXml, findRekordboxXml } from "@/lib/rekordbox-import";
import { revalidatePath } from "next/cache";
import fs from "node:fs";

export async function importRekordboxAction(xmlPath?: string) {
  const resolvedPath = xmlPath || findRekordboxXml();

  if (!resolvedPath) {
    return {
      success: false,
      error:
        "Rekordbox XML not found. Please specify the path in Settings or export your library from rekordbox (File → Export Collection in xml format).",
      imported: 0,
      updated: 0,
      playlistsCreated: 0,
    };
  }

  if (!fs.existsSync(resolvedPath)) {
    return {
      success: false,
      error: `File not found: ${resolvedPath}`,
      imported: 0,
      updated: 0,
      playlistsCreated: 0,
    };
  }

  try {
    const result = importLargeRekordboxXml(resolvedPath);
    const stats = (result as unknown as { _stats: { imported: number; updated: number; playlistsCreated: number; totalTracksProcessed: number; totalPlaylistsProcessed: number } })._stats;

    revalidatePath("/");
    revalidatePath("/library");
    revalidatePath("/playlists");

    return {
      success: true,
      imported: stats?.imported ?? 0,
      updated: stats?.updated ?? 0,
      playlistsCreated: stats?.playlistsCreated ?? 0,
      totalTracks: stats?.totalTracksProcessed ?? 0,
      totalPlaylists: stats?.totalPlaylistsProcessed ?? 0,
      errors: result.errors.slice(0, 10),
    };
  } catch (e) {
    return {
      success: false,
      error: `Import failed: ${e instanceof Error ? e.message : String(e)}`,
      imported: 0,
      updated: 0,
      playlistsCreated: 0,
    };
  }
}

export async function findRekordboxXmlPath() {
  return findRekordboxXml();
}

export async function checkFileExists(filePath: string) {
  return fs.existsSync(filePath);
}

export async function getFileSize(filePath: string) {
  try {
    const stats = fs.statSync(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}
