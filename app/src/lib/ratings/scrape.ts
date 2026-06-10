/**
 * External ratings scrapers.
 *
 * IMDB / Rotten Tomatoes don't expose a free JSON API, so we fetch the
 * public page HTML and extract the embedded JSON-LD (Schema.org) blocks,
 * which are stable across redesigns. CineMagia uses a simpler markup.
 *
 * All functions return null on any failure (network, parse, missing).
 * Callers should cache aggressively — these endpoints rate-limit hard.
 */
import * as cheerio from "cheerio";

const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface ScrapedRating {
    score: number; // 0..10 normalized
    raw?: string; // original string, e.g. "92%" for RT
    votes?: number;
    url: string;
}

async function fetchHtml(url: string): Promise<string | null> {
    try {
        const res = await fetch(url, {
            headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    }
}

/** Scrape IMDB rating from /title/{imdbId}/ JSON-LD block. */
export async function scrapeImdbRating(imdbId: string): Promise<ScrapedRating | null> {
    const url = `https://www.imdb.com/title/${imdbId}/`;
    const html = await fetchHtml(url);
    if (!html) return null;
    const $ = cheerio.load(html);
    const ldJson = $('script[type="application/ld+json"]').first().text();
    if (!ldJson) return null;
    try {
        const data = JSON.parse(ldJson) as { aggregateRating?: { ratingValue?: number; ratingCount?: number } };
        const score = data.aggregateRating?.ratingValue;
        if (typeof score !== "number") return null;
        return { score, votes: data.aggregateRating?.ratingCount, url };
    } catch {
        return null;
    }
}

/** Scrape Rotten Tomatoes Tomatometer + Audience by movie slug. */
export async function scrapeRottenTomatoes(slug: string): Promise<{ tomato: ScrapedRating | null; audience: ScrapedRating | null }> {
    const url = `https://www.rottentomatoes.com/m/${slug}`;
    const html = await fetchHtml(url);
    if (!html) return { tomato: null, audience: null };
    const $ = cheerio.load(html);

    // Modern RT exposes <score-board-deprecated> or rt-text + data attrs on
    // <media-scorecard>. Look for any element with `data-qa="critics-score"`
    // and `data-qa="audience-score"`.
    const critic = $('[data-qa="critics-score"], rt-text[slot="criticsScore"]').first().text().trim();
    const audience = $('[data-qa="audience-score"], rt-text[slot="audienceScore"]').first().text().trim();

    const parse = (raw: string): ScrapedRating | null => {
        const m = raw.match(/(\d+)\s*%?/);
        if (!m) return null;
        const pct = Number(m[1]);
        if (!Number.isFinite(pct)) return null;
        return { score: pct / 10, raw: `${pct}%`, url };
    };

    return { tomato: parse(critic), audience: parse(audience) };
}

/**
 * Best-effort CineMagia scrape (Romanian movie database).
 * Looks up by title + year, picks the first result, then reads its rating.
 */
export async function scrapeCineMagia(title: string, year?: number | null): Promise<ScrapedRating | null> {
    const q = encodeURIComponent(year ? `${title} ${year}` : title);
    const searchUrl = `https://www.cinemagia.ro/cauta/?q=${q}`;
    const searchHtml = await fetchHtml(searchUrl);
    if (!searchHtml) return null;
    const $s = cheerio.load(searchHtml);
    const firstHref = $s('a[href^="/filme/"]').first().attr("href");
    if (!firstHref) return null;
    const detailUrl = `https://www.cinemagia.ro${firstHref}`;
    const html = await fetchHtml(detailUrl);
    if (!html) return null;
    const $ = cheerio.load(html);
    // CineMagia shows the rating in `.imdb-rating-line` or `.rating`. Try a few selectors.
    const text = $(".rating, .imdb-rating-line, .scor-mediu").first().text().trim();
    const m = text.match(/(\d+(?:[.,]\d+)?)/);
    if (!m) return null;
    const score = Number(m[1].replace(",", "."));
    if (!Number.isFinite(score)) return null;
    return { score, url: detailUrl };
}

export interface ExternalRatings {
    imdb?: ScrapedRating | null;
    rtCritic?: ScrapedRating | null;
    rtAudience?: ScrapedRating | null;
    cinemagia?: ScrapedRating | null;
    fetchedAt: string;
}

/** Fetch all sources in parallel. Each is independent and may be null. */
export async function fetchExternalRatings(input: {
    imdbId?: string | null;
    rtSlug?: string | null;
    title?: string | null;
    year?: number | null;
}): Promise<ExternalRatings> {
    const [imdb, rt, cinemagia] = await Promise.all([
        input.imdbId ? scrapeImdbRating(input.imdbId) : Promise.resolve(null),
        input.rtSlug ? scrapeRottenTomatoes(input.rtSlug) : Promise.resolve({ tomato: null, audience: null }),
        input.title ? scrapeCineMagia(input.title, input.year ?? undefined) : Promise.resolve(null),
    ]);
    return {
        imdb,
        rtCritic: rt.tomato,
        rtAudience: rt.audience,
        cinemagia,
        fetchedAt: new Date().toISOString(),
    };
}
