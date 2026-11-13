import { test } from "node:test";
import assert from "node:assert/strict";
import { BRAND_SOUND_URL, BRAND_SOUND_VOLUME, startupSoundEnabled } from "./brand-sound.ts";

/** Minimal stand-ins for the browser globals the module touches. */
function install(prefs) {
    const created = [];
    class FakeAudio {
        constructor(url) { this.url = url; this.volume = 1; this.plays = 0; created.push(this); }
        // Desktop webviews reject autoplay without a user gesture.
        play() { this.plays++; return Promise.reject(new Error("NotAllowedError")); }
    }
    const store = { "mixai:prefs:v1": JSON.stringify(prefs) };
    const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
    Object.defineProperty(globalThis, "Audio", { value: FakeAudio, configurable: true, writable: true });
    Object.defineProperty(globalThis, "localStorage", { value: localStorage, configurable: true, writable: true });
    return created;
}

test("startup sound is on unless the user turned it off", () => {
    assert.equal(startupSoundEnabled({}), true);
    assert.equal(startupSoundEnabled({ startupSound: true }), true);
    assert.equal(startupSoundEnabled({ startupSound: false }), false);
    assert.equal(startupSoundEnabled({ startupSound: "off" }), true);
});

test("the sound URL is relative (file:// widget on Tizen and webOS)", () => {
    assert.match(BRAND_SOUND_URL, /^\.\/[^/]/);
});

test("plays once per app start and ignores an autoplay rejection", async () => {
    const created = install({});
    const { playStartupSound } = await import("./brand-sound.ts?on");
    playStartupSound();
    playStartupSound();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(created.length, 1);
    assert.equal(created[0].url, BRAND_SOUND_URL);
    assert.equal(created[0].volume, BRAND_SOUND_VOLUME);
    assert.equal(created[0].plays, 1);
});

test("stays silent when the setting is off", async () => {
    const created = install({ startupSound: false });
    const { playStartupSound } = await import("./brand-sound.ts?off");
    playStartupSound();
    assert.equal(created.length, 0);
});
