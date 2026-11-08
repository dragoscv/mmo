import { describe, expect, it } from "vitest";
import { parseMusicIntent, withoutIntent } from "./music-intent";

const p = (s: string) => new URLSearchParams(s);

describe("music intents", () => {
    it("parses mix and play-by-ids on the music home", () => {
        expect(parseMusicIntent("/media/music", p("mix=1"))).toEqual({ kind: "mix" });
        expect(parseMusicIntent("/media/music", p("play=tr_1,tr_2&index=1"))).toEqual({ kind: "play", ids: ["tr_1", "tr_2"], index: 1 });
        expect(parseMusicIntent("/media/music", p("play=tr_1,,tr_2&index=9"))).toEqual({ kind: "play", ids: ["tr_1", "tr_2"], index: 1 });
        expect(parseMusicIntent("/media/music", p("play=tr_1&index=x"))).toEqual({ kind: "play", ids: ["tr_1"], index: 0 });
        expect(parseMusicIntent("/media/music", p("tab=albums"))).toBeNull();
        expect(parseMusicIntent("/media/music", null)).toBeNull();
    });

    it("drops ids that are not plain ids", () => {
        expect(parseMusicIntent("/media/music", p("play=../x,<b>"))).toBeNull();
        expect(parseMusicIntent("/media/music", p("play=../x&mix=1"))).toEqual({ kind: "mix" });
    });

    it("plays search results only with play=1", () => {
        expect(parseMusicIntent("/media/music/search", p("q=chill&play=1"))).toEqual({ kind: "playSearch", q: "chill" });
        expect(parseMusicIntent("/media/music/search", p("q=&play=1"))).toEqual({ kind: "mix" });
        expect(parseMusicIntent("/media/music/search", p("q=chill"))).toBeNull();
        expect(parseMusicIntent("/search", p("q=x&play=1"))).toEqual({ kind: "playSearch", q: "x" });
    });

    it("strips only the intent keys", () => {
        expect(withoutIntent(p("tab=albums&play=tr_1&index=0&mix=1"))).toBe("tab=albums");
    });
});
