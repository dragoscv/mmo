// Run: node --test apps/mixai/src/copilot/no-lookbehind.test.ts
//
// WKWebView before Safari 16.4 (every macOS 10.15, and 11 / 12 without the Safari update; the app's
// minimum is 10.15) has no regular-expression lookbehind. It does not fail when the expression
// runs: the whole MODULE fails to parse, so one lookbehind in set-builder.ts takes down the
// import chain Library → CopilotButton → copilot-store → set-builder and the Library panel shows
// its error tile. Node and the Windows / Linux webviews accept the syntax, so no other test can
// see it. This one reads the source of every shipped file of the co-pilot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** `(?<=` and `(?<!` (named groups `(?<name>` are fine). Built from pieces so this file passes its own scan. */
const LOOKBEHIND = new RegExp(`\\(\\?<${"[=!]"}`, "g");

/** Shipped sources under `dir`, recursively: `.ts` / `.tsx` that are not tests. */
export function shippedSources(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) out.push(...shippedSources(path));
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(path);
    }
    return out;
}

/** `file:line: text` of every lookbehind in `source`. */
export function lookbehinds(source: string, file: string): string[] {
    const out: string[] = [];
    source.split("\n").forEach((line, i) => {
        if (line.search(LOOKBEHIND) >= 0) out.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
    return out;
}

const here = fileURLToPath(new URL(".", import.meta.url));
const srcRoot = fileURLToPath(new URL("..", import.meta.url));
const extra = [fileURLToPath(new URL("../bridge/copilot.ts", import.meta.url)), fileURLToPath(new URL("../i18n/messages-copilot.ts", import.meta.url))];
/** Path as shown in a failure: relative to `src/`, forward slashes. */
const shown = (file: string) => (file.startsWith(srcRoot) ? file.slice(srcRoot.length) : file).replace(/\\/g, "/");

test("no regular-expression lookbehind in the shipped co-pilot sources (WKWebView < 16.4 cannot parse it)", () => {
    const files = [...shippedSources(here), ...extra];
    // The scan must really cover the files: the parser, the store and both components.
    for (const name of ["set-builder.ts", "copilot-store.ts", "features.ts", "CopilotPopover.tsx", "CopilotButton.tsx"]) {
        assert.ok(
            files.some((f) => f.endsWith(name)),
            `${name} was not scanned`,
        );
    }
    assert.ok(files.length >= 7, `only ${files.length} files scanned`);
    assert.ok(!files.some((f) => /\.test\.tsx?$/.test(f)), "tests are not shipped and not scanned");
    const found = files.flatMap((f) => lookbehinds(readFileSync(f, "utf8"), shown(f)));
    assert.deepEqual(found, [], "rewrite with a capture: (^|\\s) instead of a lookbehind");
});

test("the scan itself sees both lookbehind forms and nothing else", () => {
    const pos = ["const a = /(?", "<=^|\\s)x/;"].join("");
    const neg = ["new RegExp('(?", "<!y)x')"].join("");
    assert.equal(lookbehinds(`ok\n${pos}\nok`, "f.ts").length, 1);
    assert.match(lookbehinds(`ok\n${pos}`, "f.ts")[0]!, /^f\.ts:2: /);
    assert.equal(lookbehinds(neg, "f.ts").length, 1);
    // Lookahead, named and non-capturing groups are fine everywhere.
    assert.deepEqual(lookbehinds("/(?=x)(?!y)(?:z)(?<year>\\d{4})(^|\\s)/", "f.ts"), []);
});
