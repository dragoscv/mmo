import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `buttonVariants` comes from a "use client" module (@mmo/ui). Calling it from a server
 * component compiles and builds fine but throws at request time ("Attempted to call
 * buttonVariants() from the server") and the page body silently disappears (web 3.1.0,
 * /account/delete). Guard every server file under src/app.
 */
const APP = join(__dirname, "..", "..");

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) return files(p);
        return /\.(tsx|ts)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
    });
}

describe("client-only helpers are not called from server components", () => {
    it("no server file under src/app calls buttonVariants()", () => {
        const offenders = files(APP).filter((f) => {
            const src = readFileSync(f, "utf8");
            const isClient = /^\s*["']use client["']/.test(src);
            return !isClient && /\bbuttonVariants\s*\(/.test(src);
        }).map((f) => relative(APP, f));
        expect(offenders).toEqual([]);
    });
});
