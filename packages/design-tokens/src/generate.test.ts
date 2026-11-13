import { describe, expect, it } from "vitest";
import {
  androidColorsXml,
  kotlinRoles,
  kotlinTokens,
  markColors,
  oklchToHex,
  oklchToSrgbHex,
  plainCss,
  prehydrateScript,
  productColors,
  swiftTokens,
  tailwindCss,
  tokensJson,
} from "./generate";
import { ACCENTS, CAMELOT, DATA_ATTRS, PREFS_STORAGE_KEY, PRODUCTS, ROLES, camelotColors, normalizePrefs, parseAccent } from "./tokens";

/** WCAG 2.x contrast ratio of two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("product identity colours", () => {
  const colors = productColors();
  const mark = markColors();
  it("maps OKLCH into sRGB by chroma reduction", () => {
    expect(oklchToSrgbHex(1, 0, 0)).toBe("#ffffff");
    expect(oklchToSrgbHex(0, 0, 0)).toBe("#000000");
    expect(oklchToSrgbHex(0.6279554, 0.2576833, 29.2338851)).toBe("#ff0000");
    // out of sRGB: clamping channels would shift the hue, chroma reduction keeps a valid colour
    expect(oklchToSrgbHex(0.7, 0.4, 145)).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("has eight products with hues at least 35 degrees apart and none on the destructive red", () => {
    const hues = Object.values(PRODUCTS).map((p) => p.dark.h).sort((a, b) => a - b);
    const red = Number(ROLES.dark.destructive.h);
    expect(hues).toHaveLength(8);
    expect(Number.isFinite(red)).toBe(true);
    hues.forEach((h, i) => {
      const next = hues[(i + 1) % hues.length]! + (i === hues.length - 1 ? 360 : 0);
      expect(next - h).toBeGreaterThanOrEqual(35);
      expect(Math.min(Math.abs(h - red), 360 - Math.abs(h - red))).toBeGreaterThanOrEqual(25);
    });
    for (const p of Object.values(PRODUCTS)) expect(p.light.h).toBe(p.dark.h);
  });
  it("every product colour passes WCAG AA where the brand uses it", () => {
    for (const [id, c] of Object.entries(colors)) {
      expect(contrast(c.dark, mark.tile), `${id} glyph on the icon tile`).toBeGreaterThanOrEqual(3);
      expect(contrast(c.dark, mark.canvas), `${id} text on dark`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.light, mark.canvasLight), `${id} text on light`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(mark.signal.dark, mark.tile)).toBeGreaterThanOrEqual(4.5);
  });
  it("emits the same sRGB value to css, json, kotlin and swift", () => {
    const css = plainCss();
    const json = JSON.parse(tokensJson());
    const kt = kotlinTokens("x", true);
    const sw = swiftTokens();
    for (const [id, c] of Object.entries(colors)) {
      expect(css).toContain(`--product-${id}: ${c.light};`);
      expect(css).toContain(`--product-${id}: ${c.dark};`);
      expect(json.products[id].hex).toEqual(c);
      const Id = id[0]!.toUpperCase() + id.slice(1);
      expect(kt).toContain(`val product${Id} = Color(0xFF${c.dark.slice(1).toUpperCase()})`);
      expect(kt).toContain(`val product${Id} = Color(0xFF${c.light.slice(1).toUpperCase()})`);
      const n = (i: number, hex: string) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4);
      expect(sw).toContain(`public static let ${id} = Color(.sRGB, red: ${n(1, c.dark)}, green: ${n(3, c.dark)}, blue: ${n(5, c.dark)}, opacity: 1.0000)`);
    }
    expect(css).toContain("--mark-a: var(--product-tv);");
    expect(css).toContain("--mark-b: var(--product-music);");
    expect(tailwindCss()).toContain("--color-product-keybpm: var(--product-keybpm);");
    expect(json.mark.colors.tile).toBe(mark.tile);
  });
  it("android colors.xml takes its values from the dark roles and the brand constants", () => {
    const xml = androidColorsXml({ bg: "background", accent: "primary", accent2: "brandCyanDark", danger: "destructive", decks_b: "brandDeckB" });
    const kt = kotlinTokens();
    const fromKotlin = (name: string) => "#" + kt.match(new RegExp(`val ${name} = Color\\(0xFF([0-9A-F]{6})\\)`))![1];
    expect(xml).toContain(`<color name="bg">${fromKotlin("background")}</color>`);
    expect(xml).toContain(`<color name="accent">${fromKotlin("primary")}</color>`);
    expect(xml).toContain(`<color name="accent2">${fromKotlin("brandCyanDark")}</color>`);
    expect(xml).toContain(`<color name="danger">${fromKotlin("destructive")}</color>`);
    expect(xml).toContain(`<color name="decks_b">${fromKotlin("brandDeckB")}</color>`);
    expect(xml.startsWith(`<?xml version="1.0" encoding="utf-8"?>`)).toBe(true);
  });
});

describe("camelot key colours", () => {
  it("has 24 distinct keys, A darker than B, and emits them to json, kotlin and swift (not css yet)", () => {
    const c = camelotColors();
    expect(Object.keys(c)).toHaveLength(24);
    expect(new Set(Object.values(c)).size).toBe(24);
    expect(CAMELOT.minor.l).toBeLessThan(CAMELOT.major.l);
    expect(plainCss()).not.toContain("--key-8a");
    expect(JSON.parse(tokensJson()).camelot["8A"]).toBe(c["8A"]);
    const kt = kotlinTokens();
    expect(kt.match(/val keyMinor = listOf\((.*)\)/)?.[1]?.split("Color(").length).toBe(13);
    expect(kt).toContain("val keyMajor = listOf(");
    expect(swiftTokens()).toContain("public static let minor: [Color]");
  });
});

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
  it("kotlinRoles emits every role, accent hues and dimensions as numbers", () => {
    const kt = kotlinRoles();
    expect(kt).toContain("object TokenRoles");
    expect(kt).toMatch(/"primary" to Oklch\(0\.7f, 0\.19f, -1f, 1\.0f\)/);
    expect(kt).toContain(`"violet" to ${ACCENTS.violet.hue}.0f`);
    expect(kt).toContain(`"compact" to 34`);
    expect(kt).toContain(`"reduced" to 0`);
    expect(kt).not.toMatch(/Color\(0x/);
  });
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
