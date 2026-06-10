import { describe, it, expect } from "vitest";
import { clusterByPredicate } from "./cluster";

describe("clusterByPredicate", () => {
    it("returns [] for empty input", () => {
        expect(clusterByPredicate<number>([], () => true)).toEqual([]);
    });

    it("returns one singleton for a one-element input", () => {
        expect(clusterByPredicate([7], () => true)).toEqual([[7]]);
    });

    it("emits singletons when no pair is linked", () => {
        const out = clusterByPredicate([1, 2, 3], () => false);
        expect(out).toHaveLength(3);
        for (const g of out) expect(g).toHaveLength(1);
    });

    it("merges all elements when every pair is linked", () => {
        const out = clusterByPredicate([1, 2, 3, 4], () => true);
        expect(out).toHaveLength(1);
        expect(out[0].sort()).toEqual([1, 2, 3, 4]);
    });

    it("transitively groups A-B and B-C even without a direct A-C link", () => {
        // Edges: 1-2, 2-3 (chain). Should produce one cluster {1,2,3}.
        const linked = (a: number, b: number) => Math.abs(a - b) === 1;
        const out = clusterByPredicate([1, 2, 3, 10], linked);
        expect(out).toHaveLength(2);
        const sizes = out.map((g) => g.length).sort();
        expect(sizes).toEqual([1, 3]);
    });

    it("preserves component membership for disjoint clusters", () => {
        // Two disjoint pairs.
        const pairs = new Set(["1|2", "3|4"]);
        const linked = (a: number, b: number) =>
            pairs.has(`${Math.min(a, b)}|${Math.max(a, b)}`);
        const out = clusterByPredicate([1, 2, 3, 4], linked);
        expect(out).toHaveLength(2);
        for (const g of out) expect(g).toHaveLength(2);
    });
});
