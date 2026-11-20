import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrateLegacyStorageKey } from "./storage-migration";

/** Minimal in-memory Storage — avoids jsdom origin quirks (opaque origin →
 *  window.localStorage undefined) and keeps this suite in the fast node env. */
function memoryStorage(): Storage {
    const map = new Map<string, string>();
    return {
        get length() {
            return map.size;
        },
        clear: () => map.clear(),
        getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
        key: (i) => [...map.keys()][i] ?? null,
        removeItem: (k) => void map.delete(k),
        setItem: (k, v) => void map.set(k, String(v)),
    };
}

describe("migrateLegacyStorageKey", () => {
    let store: Storage;
    beforeEach(() => {
        store = memoryStorage();
        vi.stubGlobal("window", { localStorage: store });
    });

    it("copies the legacy value to the new key and removes the old key", () => {
        store.setItem("muzicai-x", "v1");
        migrateLegacyStorageKey("muzicai-x", "mixai-x", store);
        expect(store.getItem("mixai-x")).toBe("v1");
        expect(store.getItem("muzicai-x")).toBeNull();
    });

    it("does not overwrite an existing new key", () => {
        store.setItem("muzicai-x", "old");
        store.setItem("mixai-x", "new");
        migrateLegacyStorageKey("muzicai-x", "mixai-x", store);
        expect(store.getItem("mixai-x")).toBe("new");
        expect(store.getItem("muzicai-x")).toBe("old");
    });

    it("is a no-op when the legacy key is absent", () => {
        migrateLegacyStorageKey("muzicai-x", "mixai-x", store);
        expect(store.getItem("mixai-x")).toBeNull();
    });

    it("defaults to window.localStorage", () => {
        store.setItem("muzicai-d", "1");
        migrateLegacyStorageKey("muzicai-d", "mixai-d");
        expect(store.getItem("mixai-d")).toBe("1");
    });

    it("swallows storage errors", () => {
        const broken = {
            ...store,
            getItem: () => {
                throw new Error("SecurityError");
            },
        } as unknown as Storage;
        expect(() => migrateLegacyStorageKey("a", "b", broken)).not.toThrow();
    });

    it("is a no-op on the server", () => {
        vi.stubGlobal("window", undefined);
        store.setItem("muzicai-s", "1");
        migrateLegacyStorageKey("muzicai-s", "mixai-s", store);
        expect(store.getItem("mixai-s")).toBeNull();
    });
});
