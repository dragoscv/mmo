import assert from "node:assert/strict";
import { test } from "node:test";
import { STRINGS, appUrl, bootstrapUrl, decide, pickLang, retryDelayMs, safePath, translator } from "./launcher.mjs";

test("EN and RO have the same keys, none empty", () => {
    assert.deepEqual(Object.keys(STRINGS.ro).sort(), Object.keys(STRINGS.en).sort());
    for (const lang of ["en", "ro"]) for (const [k, v] of Object.entries(STRINGS[lang])) assert.ok(v.trim(), `${lang}.${k}`);
});

test("language comes from the shared prefs blob, then the OS", () => {
    assert.equal(pickLang('{"locale":"ro"}', "en-US"), "ro");
    assert.equal(pickLang('{"locale":"en"}', "ro-RO"), "en");
    assert.equal(pickLang(null, "ro-RO"), "ro");
    assert.equal(pickLang("{bad json", "de-DE"), "en");
    assert.equal(translator("ro")("cancel"), "Anulează");
    assert.equal(translator("xx")("cancel"), "Cancel");
});

test("paths stay on the web app origin", () => {
    assert.equal(safePath("/media/music/album/1"), "/media/music/album/1");
    assert.equal(safePath("//evil.example/x"), "/");
    assert.equal(safePath("https://evil.example"), "/");
    assert.equal(safePath("/\\evil"), "/");
    assert.equal(safePath(undefined), "/");
    assert.equal(appUrl("https://music.mixai.ro/", "/media/music?mix=1"), "https://music.mixai.ro/media/music?mix=1");
});

test("bootstrap URL carries the token and a safe redirect", () => {
    const u = new URL(bootstrapUrl("https://music.mixai.ro", "tok en", "//evil"));
    assert.equal(u.origin + u.pathname, "https://music.mixai.ro/api/auth/desktop-bootstrap");
    assert.equal(u.searchParams.get("token"), "tok en");
    assert.equal(u.searchParams.get("redirect"), "/");
});

test("start decision", () => {
    assert.equal(decide({ online: false, signinRequested: true, signedInBefore: true }), "offline");
    assert.equal(decide({ online: true, signinRequested: true, signedInBefore: true }), "signin");
    assert.equal(decide({ online: true, signinRequested: false, signedInBefore: true }), "continue");
    assert.equal(decide({ online: true, signinRequested: false, signedInBefore: false }), "welcome");
});

test("offline retry backs off to 30 s", () => {
    assert.deepEqual([0, 1, 2, 3, 4].map(retryDelayMs), [3000, 6000, 12000, 24000, 30000]);
});
