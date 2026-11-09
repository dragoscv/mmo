import { describe, expect, it } from "vitest";
import { shortcutFor, toggleFor } from "./keyboard";

const page = null;
const el = (tag: string, role: string | null = null) => ({ tag, role, editable: false });

describe("shortcuts", () => {
    it("maps keys on the page", () => {
        expect(shortcutFor({ key: " " }, page)).toBe("bypass");
        expect(shortcutFor({ key: "m" }, page)).toBe("mute");
        expect(shortcutFor({ key: "M" }, page)).toBe("mute");
        expect(shortcutFor({ key: "ArrowLeft" }, page)).toBe("prev");
        expect(shortcutFor({ key: "ArrowRight" }, page)).toBe("next");
        expect(shortcutFor({ key: "t" }, page)).toBe("tap");
        expect(shortcutFor({ key: "Escape" }, el("input"))).toBe("escape");
    });

    it("leaves keys to focused controls and text fields", () => {
        expect(shortcutFor({ key: " " }, el("button"))).toBeNull();
        expect(shortcutFor({ key: "m" }, el("input"))).toBeNull();
        expect(shortcutFor({ key: "ArrowLeft" }, el("div", "slider"))).toBeNull();
        expect(shortcutFor({ key: "ArrowRight" }, el("button"))).toBe("next");
        expect(shortcutFor({ key: "m", ctrlKey: true }, page)).toBeNull();
        expect(shortcutFor({ key: " ", repeat: true }, page)).toBeNull();
    });

    it("toggles from the current mix", () => {
        const mix = { input_db: 0, main_db: 0, monitor_db: 0, monitor_dry: 0, bypass: true, mute: false };
        expect(toggleFor("bypass", mix)).toEqual({ bypass: false });
        expect(toggleFor("mute", mix)).toEqual({ mute: true });
        expect(toggleFor("mute", undefined)).toEqual({ mute: true });
    });
});
