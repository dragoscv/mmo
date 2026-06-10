-- Cache scraped external ratings (IMDB, Rotten Tomatoes, CineMagia) on
-- movies and tv_shows. Stored as JSONB so we can grow the source list
-- without further migrations. `*_fetched_at` lets the UI decide when to
-- refetch (e.g. older than 7 days → stale, show "Refresh" pill).

ALTER TABLE movies
    ADD COLUMN IF NOT EXISTS external_ratings jsonb,
    ADD COLUMN IF NOT EXISTS external_ratings_fetched_at timestamp;

ALTER TABLE tv_shows
    ADD COLUMN IF NOT EXISTS external_ratings jsonb,
    ADD COLUMN IF NOT EXISTS external_ratings_fetched_at timestamp;
