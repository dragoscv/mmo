/**
 * WP2-17 — nav tree ↔ i18n contract. Every node the shell can render must
 * have a `nav.<key>` string in BOTH locales, hrefs must be unique, and the
 * tree must not silently shrink (the sidebar/palette/bottom bar all read it).
 */
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import ro from "../../../messages/ro.json";
import { allLeaves, navTree, type NavNode } from "@/components/sidebar/nav-tree";
import { currentNavLabel, isTabActive, shellTabs } from "./nav-items";

const navKeys = (msgs: { nav: Record<string, string> }) => new Set(Object.keys(msgs.nav));
const enNav = navKeys(en as { nav: Record<string, string> });
const roNav = navKeys(ro as { nav: Record<string, string> });

const allKeys = (nodes: NavNode[]): string[] => nodes.flatMap((n) => (n.kind === "leaf" ? [n.key] : [n.key, ...n.children.map((c) => c.key)]));

describe("navTree ↔ messages", () => {
    it("every parent and leaf key has a non-empty nav.* string in en.json", () => {
        const missing = allKeys(navTree).filter((k) => !enNav.has(k) || !(en as { nav: Record<string, string> }).nav[k]?.trim());
        expect(missing).toEqual([]);
    });

    it("every parent and leaf key has a non-empty nav.* string in ro.json", () => {
        const missing = allKeys(navTree).filter((k) => !roNav.has(k) || !(ro as { nav: Record<string, string> }).nav[k]?.trim());
        expect(missing).toEqual([]);
    });

    it("en and ro expose the same set of nav keys", () => {
        expect([...enNav].sort()).toEqual([...roNav].sort());
    });

    it("bottom-tab keys (incl. 'more') are translatable in both locales", () => {
        for (const tab of shellTabs) {
            expect(enNav.has(tab.key), `en nav.${tab.key}`).toBe(true);
            expect(roNav.has(tab.key), `ro nav.${tab.key}`).toBe(true);
        }
    });
});

describe("navTree shape", () => {
    it("has at least 50 leaves", () => {
        expect(allLeaves.length).toBeGreaterThanOrEqual(50);
    });

    it("has no duplicate hrefs", () => {
        const hrefs = allLeaves.map((l) => l.href);
        const dupes = hrefs.filter((h, i) => hrefs.indexOf(h) !== i);
        expect(dupes).toEqual([]);
    });

    it("has no duplicate keys", () => {
        const keys = allKeys(navTree);
        const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
        expect(dupes).toEqual([]);
    });

    it("every href is an absolute app path", () => {
        expect(allLeaves.filter((l) => !l.href.startsWith("/") || l.href.includes("?"))).toEqual([]);
    });

    it("parents have ≥2 children and a first child to link to", () => {
        for (const n of navTree) {
            if (n.kind !== "parent") continue;
            expect(n.children.length, n.key).toBeGreaterThanOrEqual(2);
            expect(n.children[0]!.href).toMatch(/^\//);
        }
    });
});

describe("shellTabs", () => {
    it("has ≤5 slots with 'more' last and each nav tab pointing at its node", () => {
        expect(shellTabs.length).toBeLessThanOrEqual(5);
        expect(shellTabs.at(-1)).toMatchObject({ id: "more", more: true });
        expect(shellTabs.find((t) => t.id === "library")?.href).toBe("/library");
        expect(shellTabs.find((t) => t.id === "dashboard")?.href).toBe("/");
    });

    it("isTabActive matches the parent namespace and never the 'more' tab", () => {
        const library = shellTabs.find((t) => t.id === "library")!;
        const dashboard = shellTabs.find((t) => t.id === "dashboard")!;
        const more = shellTabs.find((t) => t.id === "more")!;
        expect(isTabActive(library, "/playlists")).toBe(true);
        expect(isTabActive(library, "/mixer")).toBe(false);
        expect(isTabActive(dashboard, "/")).toBe(true);
        expect(isTabActive(dashboard, "/library")).toBe(false);
        expect(isTabActive(more, "/settings")).toBe(false);
    });

    it("currentNavLabel resolves a leaf inside a parent, a root leaf, and null for unknown routes", () => {
        expect(currentNavLabel("/settings/appearance")).toEqual({ key: "settings-appearance", label: "Appearance & language" });
        expect(currentNavLabel("/live")).toEqual({ key: "live", label: "Live" });
        expect(currentNavLabel("/nope/nothing")).toBeNull();
    });
});
