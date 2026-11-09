/**
 * Skins that ship with the app (official, no download). Same PackInfo shape as
 * installed packs so the UI treats them alike. Colour-blind deck palettes use
 * the Okabe–Ito set (distinguishable for deuteranopia, protanopia and
 * tritanopia); the high-contrast skin passes WCAG AAA for body text.
 */
import type { PackInfo, PackTokens } from "../bridge/packs.ts";

function skin(id: string, name: string, description: string, tokens: PackTokens): PackInfo {
    return {
        manifest: { v: 1, id, name, version: "1.0.0", kind: "skin", author: "MixAI", description, pro: false },
        trust: "official",
        sha256: "builtin",
        size: 0,
        tokens,
    };
}

export const BUILTIN_SKINS: PackInfo[] = [
    skin("ro.mixai.skin.okabe-ito", "Colour-safe decks", "Deck colours that stay distinct for every type of colour blindness (Okabe–Ito).", {
        decks: { a: "#56b4e9", b: "#e69f00", c: "#009e73", d: "#cc79a7" },
    }),
    skin("ro.mixai.skin.high-contrast", "High contrast", "Pure black and white with bright accents. Body text 19:1.", {
        mode: "dark",
        surface: "solid",
        colors: {
            background: "#000000",
            foreground: "#ffffff",
            card: "#0b0b0b",
            "card-foreground": "#ffffff",
            muted: "#1a1a1a",
            "muted-foreground": "#e0e0e0",
            border: "#ffffff",
            primary: "#ffd400",
            "primary-foreground": "#000000",
            ring: "#ffd400",
        },
        decks: { a: "#00e5ff", b: "#ff4fd8", c: "#7cff4f", d: "#ffb000" },
    }),
    skin("ro.mixai.skin.booth", "Booth", "Warm amber for dark booths; easy on the eyes at 3 a.m.", {
        mode: "dark",
        surface: "solid",
        radius: "lg",
        colors: {
            background: "oklch(0.13 0.01 60)",
            foreground: "oklch(0.95 0.02 80)",
            card: "oklch(0.17 0.015 60)",
            "card-foreground": "oklch(0.95 0.02 80)",
            primary: "oklch(0.78 0.16 70)",
            "primary-foreground": "oklch(0.15 0.02 60)",
            ring: "oklch(0.78 0.16 70)",
        },
    }),
    skin("ro.mixai.skin.studio-light", "Studio light", "Light, flat studio look for daylight prep.", {
        mode: "light",
        surface: "flat",
        density: "comfortable",
    }),
];
