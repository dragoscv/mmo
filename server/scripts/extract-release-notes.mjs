#!/usr/bin/env node
// Extract the topmost release section from CHANGELOG.md so the Companion
// release workflow can pass it to electron-builder as release notes.
//
// Strategy: scan the repo-root CHANGELOG.md (one level above /server) for
// the first H2 ("## ...") block — typically `## [Unreleased]` while a
// release is being staged, or `## [vX.Y.Z] - DATE` after a tag. Strip the
// heading itself and write the body to the path given in argv[2] (or
// `server/release/RELEASE_NOTES.md` by default). Falls back to "See
// CHANGELOG.md" if nothing usable is found, so the build never fails just
// because the changelog is in flux.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const changelogPath = resolve(here, "..", "..", "CHANGELOG.md");
const outPath = resolve(here, "..", process.argv[2] ?? "release/RELEASE_NOTES.md");

let body = "See CHANGELOG.md";
try {
    const raw = readFileSync(changelogPath, "utf8");
    // Find the first "## " heading line, then capture everything up to (but
    // excluding) the next "## " heading, or end-of-file. A regex with both
    // a non-greedy capture and a multiline-end alternation tends to bail
    // out at the first blank line via "$", so we slice manually instead.
    const startIdx = raw.search(/^##\s/m);
    if (startIdx >= 0) {
        const block = raw.slice(startIdx);
        const nextIdx = block.search(/\n##\s/);
        const section = nextIdx >= 0 ? block.slice(0, nextIdx) : block;
        // Strip the heading line itself; keep the body.
        const stripped = section.replace(/^##\s[^\n]*\n?/, "").trim();
        if (stripped.length > 0) body = stripped;
    }
} catch {
    // CHANGELOG missing — keep the fallback body.
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, body + "\n", "utf8");
console.log(`[release-notes] wrote ${body.length} chars to ${outPath}`);
