/**
 * Tiny synchronous JSON-file store — drop-in for the subset of
 * `electron-store` the server uses (`get`, `set`, `delete`, `.store`, `.path`).
 *
 * File layout is identical to electron-store/conf: `<cwd>/<name>.json`,
 * tab-indented JSON, `cwd` defaulting to `platform.getPath("userData")`.
 * That means an existing `config.json` written by electron-store is read
 * unchanged, and the Electron shell and the headless process share one
 * on-disk format. Writes are atomic (tmp + rename).
 *
 * Not supported on purpose: dot-path keys, schema validation, encryption,
 * change watchers — none are used by the server.
 */

import fs from "node:fs";
import path from "node:path";
import { platform } from "./index";

export interface SettingsStoreOptions<T extends Record<string, unknown>> {
    /** File base name (default `config` → `config.json`). */
    name?: string;
    /** Directory; default `platform.getPath("userData")`. Relative paths resolve against it. */
    cwd?: string;
    defaults?: Partial<T>;
}

export class SettingsStore<T extends Record<string, unknown> = Record<string, unknown>> {
    readonly path: string;
    private readonly defaults: Partial<T>;
    private data: Record<string, unknown>;

    constructor(opts: SettingsStoreOptions<T> = {}) {
        const base = platform.getPath("userData");
        const cwd = opts.cwd ? (path.isAbsolute(opts.cwd) ? opts.cwd : path.join(base, opts.cwd)) : base;
        this.path = path.join(cwd, `${opts.name ?? "config"}.json`);
        this.defaults = opts.defaults ?? {};
        this.data = { ...(this.defaults as Record<string, unknown>), ...this.readFile() };
    }

    private readFile(): Record<string, unknown> {
        try {
            const raw = fs.readFileSync(this.path, "utf8");
            const parsed = JSON.parse(raw) as unknown;
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : {};
        } catch (e) {
            const code = (e as NodeJS.ErrnoException)?.code;
            if (code !== "ENOENT") {
                // eslint-disable-next-line no-console
                console.warn(`[settings-store] could not read ${this.path}:`, e instanceof Error ? e.message : String(e));
            }
            return {};
        }
    }

    private writeFile(): void {
        const dir = path.dirname(this.path);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, "\t"), "utf8");
        try {
            fs.renameSync(tmp, this.path);
        } catch {
            // Windows can refuse rename over a file another handle has open; fall back.
            fs.copyFileSync(tmp, this.path);
            try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        }
    }

    get<K extends keyof T & string>(key: K): T[K];
    get<K extends keyof T & string>(key: K, defaultValue: T[K]): T[K];
    get(key: string, defaultValue?: unknown): unknown;
    get(key: string, defaultValue?: unknown): unknown {
        const v = this.data[key];
        return v === undefined ? defaultValue : v;
    }

    has(key: string): boolean {
        return this.data[key] !== undefined;
    }

    set<K extends keyof T & string>(key: K, value: T[K]): void;
    set(key: string, value: unknown): void;
    set(object: Partial<T>): void;
    set(keyOrObject: string | Partial<T>, value?: unknown): void {
        if (typeof keyOrObject === "object" && keyOrObject !== null) {
            for (const [k, v] of Object.entries(keyOrObject)) {
                if (v === undefined) delete this.data[k]; else this.data[k] = v;
            }
        } else {
            if (value === undefined) delete this.data[keyOrObject as string];
            else this.data[keyOrObject as string] = value;
        }
        this.writeFile();
    }

    delete(key: string): void {
        if (!(key in this.data)) return;
        delete this.data[key];
        this.writeFile();
    }

    clear(): void {
        this.data = { ...(this.defaults as Record<string, unknown>) };
        this.writeFile();
    }

    /** Snapshot of all data (defaults merged). */
    get store(): T {
        return { ...(this.data as T) };
    }

    get size(): number {
        return Object.keys(this.data).length;
    }
}
