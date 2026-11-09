// Run: node --test apps/mixai/src/bridge/packs.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pickedBytes } from "./packs.ts";
import { MARKET_ORIGIN } from "./marketplace.ts";

test("pack_pick_file: empty ArrayBuffer = cancelled, bytes otherwise", () => {
    assert.equal(pickedBytes(null), null);
    assert.equal(pickedBytes(new ArrayBuffer(0)), null);
    assert.deepEqual([...pickedBytes(new Uint8Array([7, 8]).buffer)!], [7, 8]);
});

test("pack bytes never cross IPC as a JSON number array", () => {
    const src = readFileSync(new URL("./packs.ts", import.meta.url), "utf8");
    assert.ok(!/Array\.from\(bytes\)/.test(src));
    assert.match(src, /invoke<PackInfo>\("pack_inspect", bytes\)/);
    assert.match(src, /invoke<PackInfo>\("pack_install", bytes\)/);
});

type Csp = Record<string, string>;
const conf = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as {
    app: { security: { csp: Csp | null; devCsp?: Csp; dangerousDisableAssetCspModification?: string[] } };
};

test("the webview has a real CSP (not null) that still allows what the app needs", () => {
    const csp = conf.app.security.csp;
    assert.ok(csp && typeof csp === "object", "csp must not be null");
    assert.equal(csp["default-src"], "'self'");
    assert.equal(csp["script-src"], "'self'", "no inline/remote scripts");
    assert.equal(csp["object-src"], "'none'");
    assert.equal(csp["frame-src"], "'none'");
    assert.ok(csp["connect-src"]!.split(" ").includes(MARKET_ORIGIN), "marketplace fetch");
    assert.ok(csp["connect-src"]!.includes("ipc:"), "Tauri IPC");
    assert.ok(csp["img-src"]!.split(" ").includes(MARKET_ORIGIN), "marketplace previews");
    assert.ok(csp["img-src"]!.includes("data:") && csp["font-src"]!.includes("data:"), "pack assets are data: URLs");
    // Skins inject <style> and the UI uses style attributes: Tauri must not add nonces to style-src
    // (a nonce makes browsers ignore 'unsafe-inline').
    assert.ok(csp["style-src"]!.includes("'unsafe-inline'"));
    assert.deepEqual(conf.app.security.dangerousDisableAssetCspModification, ["style-src"]);
    for (const [k, v] of Object.entries(csp)) assert.ok(!/localhost:|'unsafe-eval'|\*/.test(v), `${k}: ${v}`);
});

test("dev CSP only adds the Vite dev server (+ inline React refresh preamble)", () => {
    const dev = conf.app.security.devCsp!;
    assert.equal(dev["script-src"], "'self' 'unsafe-inline' http://localhost:14420");
    assert.ok(dev["connect-src"]!.includes("ws://localhost:14420"), "HMR socket");
});
