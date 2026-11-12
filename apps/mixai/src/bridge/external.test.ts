// Run: cd apps/mixai; node --test src/bridge/external.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EXTERNAL_URLS, MIXCLOUD_UPLOAD_URL, isAllowedExternal, openExternal, type InvokeFn } from "./external.ts";

function recorder(fail = false) {
    const calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];
    const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (fail) throw new Error("Scoped command argument at position 0 was found, but failed regex validation");
        return null;
    }) as InvokeFn;
    return { calls, invoke };
}

test("an allowed URL goes to the shell plugin with exactly the arguments its command declares", async () => {
    const r = recorder();
    assert.equal(await openExternal(MIXCLOUD_UPLOAD_URL, { invoke: r.invoke }), "opened");
    assert.deepEqual(r.calls, [{ cmd: "plugin:shell|open", args: { path: "https://www.mixcloud.com/upload/" } }]);
});

test("any other URL is refused before anything is called", async () => {
    const r = recorder();
    let opened = 0;
    const open = () => {
        opened++;
    };
    const others = [
        "https://www.mixcloud.com/upload",
        "https://www.mixcloud.com/upload/?next=https://evil.example",
        "https://www.mixcloud.com/upload/../settings",
        "http://www.mixcloud.com/upload/",
        "https://mixcloud.com/upload/",
        "https://www.mixcloud.com.evil.example/upload/",
        " https://www.mixcloud.com/upload/",
        "HTTPS://WWW.MIXCLOUD.COM/UPLOAD/",
        "file:///C:/Windows/System32/calc.exe",
        "C:\\Windows\\System32\\calc.exe",
        "javascript:alert(1)",
        "mailto:someone@example.com",
        "",
    ];
    for (const url of others) {
        assert.equal(await openExternal(url, { invoke: r.invoke, open }), "refused", url);
        assert.equal(isAllowedExternal(url), false, url);
    }
    for (const junk of [null, undefined, 5, {}, [MIXCLOUD_UPLOAD_URL]]) assert.equal(await openExternal(junk as never, { invoke: r.invoke, open }), "refused");
    assert.equal(r.calls.length, 0);
    assert.equal(opened, 0);
});

test("a refusal or an error of the shell is reported, never thrown", async () => {
    const r = recorder(true);
    assert.equal(await openExternal(MIXCLOUD_UPLOAD_URL, { invoke: r.invoke }), "failed");
    assert.equal(r.calls.length, 1);
});

test("outside Tauri the page opens in a new tab without an opener", async () => {
    const seen: unknown[][] = [];
    const open = (...a: unknown[]) => {
        seen.push(a);
        return null;
    };
    assert.equal(await openExternal(MIXCLOUD_UPLOAD_URL, { invoke: null, open }), "opened");
    assert.deepEqual(seen, [["https://www.mixcloud.com/upload/", "_blank", "noopener"]]);
    const boom = () => {
        throw new Error("blocked");
    };
    assert.equal(await openExternal(MIXCLOUD_UPLOAD_URL, { invoke: null, open: boom }), "failed");
});

test("every allowed URL is https and passes the shell plugin's default open scope", () => {
    // tauri-plugin-shell 2.6.0 src/lib.rs `open_scope`: with no `plugins.shell.open` in tauri.conf.json.
    const scope = /^((mailto:\w+)|(tel:\w+)|(https?:\/\/\w+)).+/;
    assert.ok(EXTERNAL_URLS.length >= 1);
    for (const url of EXTERNAL_URLS) {
        assert.match(url, /^https:\/\//, url);
        assert.match(url, scope, url);
        assert.equal(new URL(url).href, url, "already in its normal form");
    }
});

test("the app grants the open permission, starts the plugin, and leaves its scope at the default", () => {
    const root = new URL("../../src-tauri/", import.meta.url);
    const cap = JSON.parse(readFileSync(new URL("capabilities/main.json", root), "utf8")) as { permissions: unknown[] };
    assert.ok(cap.permissions.includes("shell:allow-open"), "capabilities/main.json lost shell:allow-open");
    assert.match(readFileSync(new URL("src/lib.rs", root), "utf8"), /\.plugin\(tauri_plugin_shell::init\(\)\)/);
    const conf = JSON.parse(readFileSync(new URL("tauri.conf.json", root), "utf8")) as { plugins?: Record<string, unknown> };
    // A `plugins.shell.open` entry would replace the default scope: this test must then be revisited.
    assert.equal(conf.plugins?.shell, undefined);
    // The JS wrapper package is not a dependency: the command is invoked by name.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", root), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    assert.equal(pkg.dependencies?.["@tauri-apps/plugin-shell"], undefined);
    assert.equal(pkg.devDependencies?.["@tauri-apps/plugin-shell"], undefined);
});
