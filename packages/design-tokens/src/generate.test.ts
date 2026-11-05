import { describe, expect, it } from "vitest";
import { kotlinTokens, oklchToHex, plainCss, prehydrateScript, swiftTokens, tailwindCss } from "./generate";
import { ACCENTS, DATA_ATTRS, PREFS_STORAGE_KEY, normalizePrefs, parseAccent } from "./tokens";

describe("tokens css", () => {
  const css = tailwindCss();
  it("emits every accent preset selector with its hue", () => {
    for (const [name, def] of Object.entries(ACCENTS)) {
      expect(css).toContain(`:root[${DATA_ATTRS.accent}="${name}"] {\n  --accent-h: ${def.hue};`);
    }
  });
  it("maps primary through the accent hue var", () => {
    expect(css).toMatch(/--primary: oklch\([\d.]+ [\d.]+ var\(--accent-h\)\)/);
  });
  it("dark block also matches legacy .dark class", () => {
    expect(css).toContain(`:root[data-mode="dark"], .dark {`);
  });
  it("plain flavour has no tailwind directives", () => {
    const plain = plainCss();
    expect(plain).not.toContain("@theme");
    expect(plain).not.toContain("@utility");
    expect(plain).toContain("--accent-h");
  });
});

describe("kotlin", () => {
  it("converts oklch to AARRGGBB", () => {
    expect(oklchToHex(1, 0, 0)).toBe("FFFFFFFF");
    expect(oklchToHex(0, 0, 0)).toBe("FF000000");
    expect(oklchToHex(0.7, 0.19, 285)).toMatch(/^FF[0-9A-F]{6}$/);
  });
  it("emits a Tokens object with brand colours", () => {
    const kt = kotlinTokens();
    expect(kt).toContain("object Tokens");
    expect(kt).toContain("val brandViolet = Color(0xFF7C5CFF)");
    expect(kt).toContain("val primary = Color(0x");
  });
});

describe("swift", () => {
  it("emits dark + light roles and brand colours as sRGB", () => {
    const sw = swiftTokens();
    expect(sw).toContain("public enum Tokens");
    expect(sw).toContain("public enum Dark");
    expect(sw).toContain("public enum Light");
    // #7c5cff → 124/255, 92/255, 255/255
    expect(sw).toContain("public static let violet = Color(.sRGB, red: 0.4863, green: 0.3608, blue: 1.0000, opacity: 1.0000)");
    expect(sw).toMatch(/public static let primary = Color\(\.sRGB, red: 0\.\d{4}/);
    expect(sw).not.toContain("#");
  });
});

describe("prehydrate", () => {
  it("is ES2017-safe (no arrow fns, no optional chaining) and references the storage key", () => {
    const js = prehydrateScript();
    expect(js).toContain(PREFS_STORAGE_KEY);
    expect(js).not.toMatch(/=>/);
    expect(js).not.toMatch(/\?\./);
    expect(js.length).toBeLessThan(2200);
  });
});

describe("prefs", () => {
  it("normalizes garbage to defaults", () => {
    const p = normalizePrefs({ mode: "neon", accent: "custom:400", surface: 3 });
    expect(p.mode).toBe("system");
    expect(p.accent).toBe("custom:400");
    expect(p.surface).toBe("glass");
  });
  it("parses accents", () => {
    expect(parseAccent("custom:400")).toEqual({ attr: "custom", hue: 40 });
    expect(parseAccent("artwork")).toEqual({ attr: "artwork", hue: null });
    expect(parseAccent("cyan")).toEqual({ attr: "cyan", hue: 200 });
  });
});
