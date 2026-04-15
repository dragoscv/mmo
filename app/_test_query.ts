import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

const sqlite = new Database('./data/music-organizer.db');
const db = drizzle(sqlite);

const playlists = sqliteTable('playlists', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  description: text('description'),
  type: text('type'),
  createdAt: text('created_at'),
});

const result = db
  .select({
    id: playlists.id,
    name: playlists.name,
    description: playlists.description,
    type: playlists.type,
    createdAt: playlists.createdAt,
    trackCount: sql`(SELECT COUNT(*) FROM playlist_tracks WHERE playlist_tracks.playlist_id = playlists.id)`,
  })
  .from(playlists)
  .orderBy(playlists.name)
  .all();

console.log('First 5 results:');
console.log(JSON.stringify(result.slice(0, 5), null, 2));
console.log('trackCount type:', typeof result[0]?.trackCount);
console.log('trackCount value:', result[0]?.trackCount);