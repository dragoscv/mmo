/**
 * Load an ESM-only package from this CommonJS build.
 *
 * `tsc` with `module: "commonjs"` rewrites a literal `import("pkg")` into
 * `require("pkg")`, which throws `ERR_REQUIRE_ESM` for packages that ship
 * only ESM (`chokidar` >= 5, `music-metadata` >= 11). Going through
 * `new Function` keeps a real dynamic `import()` in the emitted JS.
 *
 * Node 22 can `require()` a synchronous ESM graph, but Electron's main
 * process cannot, so the async form is the portable one. Callers cache the
 * returned promise — the module is only ever evaluated once by Node.
 */
const dynamicImport: (specifier: string) => Promise<unknown> =
    new Function("s", "return import(s)") as (specifier: string) => Promise<unknown>;

export function importEsm<T>(specifier: string): Promise<T> {
    return dynamicImport(specifier) as Promise<T>;
}

/** Memoised `importEsm` — one in-flight promise per specifier. */
export function lazyEsm<T>(specifier: string): () => Promise<T> {
    let p: Promise<T> | null = null;
    return () => (p ??= importEsm<T>(specifier));
}
