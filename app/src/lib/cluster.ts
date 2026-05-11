/**
 * Connected-component clustering over a similarity predicate. Pulled
 * out of `actions/duplicates.ts` so it can live next to its tests
 * (the action file is `"use server"` and only exports async).
 *
 * Used by the audio-fingerprint duplicate strategy: within each
 * prefix-bucket, two tracks are "linked" if their decoded Chromaprint
 * Hamming-similarity is above a threshold. We emit each connected
 * component as a duplicate group so chains like A≈B≈C all surface
 * even when A and C don't directly share enough bits.
 */

/**
 * Group `items` into connected components using `linked(a, b)` as the
 * edge predicate. Pure, deterministic, O(n²) in the worst case — the
 * caller is expected to pre-bucket so each call sees a small `items`.
 */
export function clusterByPredicate<T>(
    items: T[],
    linked: (a: T, b: T) => boolean,
): T[][] {
    const n = items.length;
    if (n === 0) return [];
    if (n === 1) return [items.slice()];

    // Union-find over indices.
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => {
        let r = x;
        while (parent[r] !== r) r = parent[r];
        // Path compression.
        let cur = x;
        while (parent[cur] !== r) {
            const next = parent[cur];
            parent[cur] = r;
            cur = next;
        }
        return r;
    };
    const union = (a: number, b: number): void => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[ra] = rb;
    };

    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (linked(items[i], items[j])) union(i, j);
        }
    }

    const groups = new Map<number, T[]>();
    for (let i = 0; i < n; i++) {
        const root = find(i);
        const g = groups.get(root) ?? [];
        g.push(items[i]);
        groups.set(root, g);
    }
    return Array.from(groups.values());
}
