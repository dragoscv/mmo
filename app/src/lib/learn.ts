import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * `/learn` content layer. The 6 markdown corpora at the repo root are
 * mirrored into `app/learn-content/` by `scripts/sync-learn-content.mjs`
 * during `predev` / `prebuild`, so Next.js outputFileTracing bundles
 * them into the serverless build. Anything under that folder is a
 * potential page; we treat each top-level directory as a "section"
 * (Concept, Docs, Genuri, …) and each `.md` file inside (recursively)
 * as a page slug.
 */

const ROOT = resolve(process.cwd(), "learn-content");

export interface LearnSection {
    slug: string;
    title: string;
    description: string;
    pageCount: number;
}

export interface LearnPageRef {
    section: string;
    slug: string;       // dot-joined path without .md (e.g. "arhitectura.01-prezentare-generala")
    title: string;
    relPath: string;    // path inside the section (e.g. "arhitectura/01-prezentare-generala.md")
}

export interface LearnPage extends LearnPageRef {
    body: string;       // raw markdown
}

// User-facing labels for each section (slug -> { title, description }).
// Translation lives in messages/{en,ro}.json under `learn.sections.<slug>`.
const SECTION_META: Record<string, { titleKey: string; descKey: string }> = {
    concept: { titleKey: "concept.title", descKey: "concept.desc" },
    docs: { titleKey: "docs.title", descKey: "docs.desc" },
    organizare: { titleKey: "organizare.title", descKey: "organizare.desc" },
    genuri: { titleKey: "genuri.title", descKey: "genuri.desc" },
    echipament: { titleKey: "echipament.title", descKey: "echipament.desc" },
    glosar: { titleKey: "glosar.title", descKey: "glosar.desc" },
};

export const LEARN_SECTION_SLUGS = Object.keys(SECTION_META);

function safeRead(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return null;
    }
}

/** Extract first markdown H1 from the body, or fall back to the slug. */
export function extractTitle(body: string, fallback: string): string {
    for (const line of body.split(/\r?\n/, 30)) {
        const m = line.match(/^#\s+(.+?)\s*$/);
        if (m) return m[1].replace(/[#*_`]/g, "").trim();
    }
    return fallback;
}

/** Slug-encode a relative path: "arhitectura/01-foo.md" -> "arhitectura.01-foo". */
export function pathToSlug(relPath: string): string {
    return relPath.replace(/\.md$/i, "").split(/[\\/]/).join(".");
}

/** Inverse of pathToSlug. Always re-appends `.md`. */
export function slugToPath(slug: string): string {
    return `${slug.split(".").join("/")}.md`;
}

function walkMd(dir: string, base = ""): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const rel = base ? `${base}/${entry}` : entry;
        const st = statSync(full);
        if (st.isDirectory()) out.push(...walkMd(full, rel));
        else if (entry.toLowerCase().endsWith(".md")) out.push(rel);
    }
    return out.sort();
}

export function listSections(): LearnSection[] {
    return LEARN_SECTION_SLUGS.map((slug) => {
        const dir = join(ROOT, slug);
        const pages = walkMd(dir);
        return {
            slug,
            title: SECTION_META[slug].titleKey,
            description: SECTION_META[slug].descKey,
            pageCount: pages.length,
        };
    }).filter((s) => s.pageCount > 0);
}

export function listSectionPages(section: string): LearnPageRef[] {
    if (!LEARN_SECTION_SLUGS.includes(section)) return [];
    const dir = join(ROOT, section);
    return walkMd(dir).map((relPath) => {
        const body = safeRead(join(dir, relPath)) ?? "";
        return {
            section,
            slug: pathToSlug(relPath),
            relPath,
            title: extractTitle(body, relPath.replace(/\.md$/, "")),
        };
    });
}

export function getPage(section: string, slug: string): LearnPage | null {
    if (!LEARN_SECTION_SLUGS.includes(section)) return null;
    // Defence-in-depth: the slug came from a URL, so refuse anything that
    // could traverse out of the section directory after slugToPath().
    if (slug.includes("..") || slug.includes("/") || slug.includes("\\")) return null;
    const relPath = slugToPath(slug);
    const full = join(ROOT, section, relPath);
    if (!full.startsWith(ROOT)) return null;
    const body = safeRead(full);
    if (body === null) return null;
    return {
        section,
        slug,
        relPath,
        title: extractTitle(body, slug),
        body,
    };
}
