// Run: cd apps/mixai; node --test src/setlog/actions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyKey, copyTracklist, uploadKeys, uploadToMixcloud } from "./actions.ts";
import type { Entry } from "./set-logger.ts";

const set: Entry[] = [
    { track: { id: "1", title: "Strobe", artist: "deadmau5" }, deck: "a", startSec: 0, playedSec: 312 },
    { track: { id: "2", title: "Levels", artist: "Avicii" }, deck: "b", startSec: 312.4, playedSec: 200 },
];
const TEXT = "01. [0:00] deadmau5 – Strobe\n02. [5:12] Avicii – Levels\n";

function clip(fail = false) {
    const written: string[] = [];
    return {
        written,
        clipboard: {
            writeText: async (t: string) => {
                if (fail) throw new Error("Document is not focused.");
                written.push(t);
            },
        },
    };
}

test("copy writes the tracklist text, once", async () => {
    const c = clip();
    assert.equal(await copyTracklist(set, c), "copied");
    assert.deepEqual(c.written, [TEXT]);
});

test("an empty tracklist writes nothing; a refusing or missing clipboard is a failure, not a throw", async () => {
    const c = clip();
    assert.equal(await copyTracklist([], c), "empty");
    assert.equal(c.written.length, 0);
    assert.equal(await copyTracklist(set, clip(true)), "failed");
    assert.equal(await copyTracklist(set, { clipboard: null }), "failed");
});

test("upload copies first, then opens the Mixcloud upload page", async () => {
    const order: string[] = [];
    const r = await uploadToMixcloud(set, {
        clipboard: {
            writeText: async (t) => {
                order.push(`copy:${t.length}`);
            },
        },
        open: async (url) => {
            order.push(`open:${url}`);
            return "opened";
        },
    });
    assert.deepEqual(r, { copy: "copied", open: "opened" });
    assert.deepEqual(order, [`copy:${TEXT.length}`, "open:https://www.mixcloud.com/upload/"]);
});

test("the page is opened even when the copy failed or there was nothing to copy", async () => {
    let opened = 0;
    const open = async () => {
        opened++;
        return "opened" as const;
    };
    assert.deepEqual(await uploadToMixcloud(set, { ...clip(true), open }), { copy: "failed", open: "opened" });
    assert.deepEqual(await uploadToMixcloud([], { ...clip(), open }), { copy: "empty", open: "opened" });
    assert.equal(opened, 2);
    assert.deepEqual(await uploadToMixcloud(set, { ...clip(), open: async () => "failed" }), { copy: "copied", open: "failed" });
});

test("every outcome has its own sentence", () => {
    assert.equal(copyKey("copied"), "setlog.copied");
    assert.equal(copyKey("empty"), "setlog.copyEmpty");
    assert.equal(copyKey("failed"), "setlog.copyFailed");
    assert.deepEqual(uploadKeys({ copy: "copied", open: "opened" }), ["setlog.open.ok", "setlog.clip.ok"]);
    assert.deepEqual(uploadKeys({ copy: "empty", open: "opened" }), ["setlog.open.ok", "setlog.clip.empty"]);
    assert.deepEqual(uploadKeys({ copy: "failed", open: "failed" }), ["setlog.open.failed", "setlog.clip.failed"]);
    assert.deepEqual(uploadKeys({ copy: "copied", open: "refused" }), ["setlog.open.failed", "setlog.clip.ok"]);
});
