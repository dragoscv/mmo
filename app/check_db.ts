import { db } from './src/db';
import { sql } from 'drizzle-orm';

const total = db.all(sql`SELECT COUNT(*) as cnt FROM playlist_tracks`);
console.log('Total playlist_tracks rows:', total);

const perPlaylist = db.all(sql`SELECT playlist_id, COUNT(*) as cnt FROM playlist_tracks GROUP BY playlist_id ORDER BY cnt DESC LIMIT 10`);
console.log('Top 10 playlists by track count:', perPlaylist);

const totalPl = db.all(sql`SELECT COUNT(*) as cnt FROM playlists`);
console.log('Total playlists:', totalPl);