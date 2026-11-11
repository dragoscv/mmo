/**
 * Skins that ship with the app (official, no download). Same PackInfo shape as
 * installed packs so the UI treats them alike. Colour-blind deck palettes use
 * the Okabe–Ito set (distinguishable for deuteranopia, protanopia and
 * tritanopia); the high-contrast skin passes WCAG AAA for body text.
 *
 * The "familiar" skins (Mainroom, Crate, Pilot) follow the screen conventions of other DJ
 * applications (which grey is a panel, where colour is allowed, how the waveform is tinted)
 * so a DJ who switches finds a screen that reads the same way. They carry neutral names, no
 * logos and no artwork of those products; the colours are our own picks checked for contrast.
 * User-visible names and descriptions are also in `i18n/messages-skins.ts` (`skins.b.<slug>.*`).
 */
import type { PackInfo, PackTokens } from "../bridge/packs.ts";

function skin(id: string, name: string, description: string, tokens: PackTokens): PackInfo {
    return {
        // A `style` block needs manifest v2 (Decks >= 1.5).
        manifest: { v: tokens.style ? 2 : 1, id, name, version: "1.0.0", kind: "skin", author: "MixAI", description, pro: false },
        trust: "official",
        sha256: "builtin",
        size: 0,
        tokens,
    };
}

export const SKIN_GLASS_CLASSIC = "ro.mixai.skin.glass-classic";
export const SKIN_MAINROOM = "ro.mixai.skin.mainroom";
export const SKIN_CRATE = "ro.mixai.skin.crate";
export const SKIN_PILOT = "ro.mixai.skin.pilot";

/** Decks 1.x: glass panels, violet accent, roomy controls, the 1.x panel arrangement. */
const GLASS_CLASSIC: PackTokens = {
    mode: "dark",
    accent: "violet",
    surface: "glass",
    density: "comfortable",
    radius: "lg",
    style: { look: "classic", layout: "classic" },
};

/**
 * Mainroom: black window, flat neutral grey tiles, ONE blue for every ON state, waveform in
 * blue tones (bass dark, treble near white), no deck colours (decks differ by position and
 * number only), green PLAY and amber CUE, square corners.
 */
const MAINROOM: PackTokens = {
    mode: "dark",
    surface: "flat",
    density: "compact",
    radius: "sm",
    colors: {
        background: "#000000",
        foreground: "#ffffff",
        card: "#1e1e1e",
        "card-foreground": "#ffffff",
        popover: "#232323",
        "popover-foreground": "#ffffff",
        secondary: "#2b2b2b",
        "secondary-foreground": "#ffffff",
        muted: "#2b2b2b",
        "muted-foreground": "#b4b4b4",
        border: "#3d3d3d",
        input: "#4a4a4a",
        primary: "#1470e6",
        "primary-foreground": "#ffffff",
        accent: "#1d4468",
        "accent-foreground": "#ffffff",
        ring: "#4d9bff",
    },
    decks: { a: "#dfe7f2", b: "#dfe7f2", c: "#dfe7f2", d: "#dfe7f2" },
    style: {
        look: "signature",
        layout: "pro",
        waves: "stacked",
        colors: {
            well: "#111111",
            waveBg: "#000000",
            line: "#3d3d3d",
            faint: "#9c9c9c",
            on: "#1470e6",
            onFg: "#ffffff",
            play: "#46a85c",
            playFg: "#04120a",
            cue: "#eab651",
            alert: "#f0453d",
            waveLow: "#0d55d6",
            waveMid: "#3f9cec",
            waveHigh: "#e4f0fb",
            waveGrid: "#8a8a8a",
            waveDownbeat: "#e0443c",
            wavePlayhead: "#e6edf2",
            wavePlayheadCap: "#e72727",
            cue1: "#e0507f",
            cue2: "#d08a5e",
            cue3: "#6f9ed6",
            cue4: "#cdb84e",
            cue5: "#8fb86c",
            cue6: "#9a80c8",
            cue7: "#7fb4c6",
            cue8: "#5cb884",
        },
        sizes: { panelGap: 2, panelRadius: 0, controlRadius: 2, padRadius: 2, wavePlayedAlpha: 1 },
    },
};

/*
 * Hex or oklch() for a grey surface? Up to 1.5.0-dev the look tinted with
 * `color-mix(in oklch, …)` (hover, zebra rows, selected fills), which interpolates the HUE, and a
 * near-grey hex operand has no hue there ("none"). Measured in the app's webview at that time:
 * - Greys with a VISIBLE tint (Pilot's blue-grey, chroma ≈ 0.009) must be oklch(): as hex, a
 *   grey + grey mix keeps the chroma but loses the hue, and the zebra rows turned pink.
 * - Greys with no visible tint (Mainroom, Crate: chroma ≤ 0.002) must stay hex: hueless, so a mix
 *   with the ON colour takes that colour's hue. Written as oklch() with a warm hue, Crate's
 *   selected row (blue ON 18 % over the panel) went olive, half-way round the hue circle.
 * The look's CSS now mixes `in oklab` (a straight line, no hue to interpolate), so either grammar
 * gives the same tint; the rule above is kept because it is also right for any pack CSS or older
 * build that still mixes in oklch.
 */

/**
 * Crate: warm dark grey panels with controls as BLACK wells sunk into them, one deep blue for
 * ON, a full-spectrum waveform on black (bass red, mids green, treble blue), the classic eight
 * hot cue colours, the virtual platter, waveforms between the decks.
 */
const CRATE: PackTokens = {
    mode: "dark",
    surface: "flat",
    density: "compact",
    radius: "sm",
    colors: {
        background: "#1b1a19",
        foreground: "#f4f3f1",
        card: "#2a2928",
        "card-foreground": "#f4f3f1",
        popover: "#201f1e",
        "popover-foreground": "#f4f3f1",
        secondary: "#090909", // controls are wells
        "secondary-foreground": "#f4f3f1",
        muted: "#090909",
        "muted-foreground": "#b5b3b0",
        border: "#444341",
        input: "#545250",
        primary: "#0a7ac6",
        "primary-foreground": "#ffffff",
        accent: "#004e81",
        "accent-foreground": "#ffffff",
        ring: "#35a2ea",
    },
    decks: { a: "#3aaaf2", b: "#3aaaf2", c: "#3aaaf2", d: "#3aaaf2" },
    style: {
        look: "signature",
        layout: "pro-vertical",
        platter: true,
        waves: "stacked",
        colors: {
            well: "#050505",
            waveBg: "#000000",
            line: "#444341",
            faint: "#a09e9c",
            on: "#0a7ac6",
            onFg: "#ffffff",
            play: "#0a7ac6",
            playFg: "#ffffff",
            cue: "#d8d6d3",
            alert: "#ff3b30",
            waveLow: "#e0262c",
            waveMid: "#2fca4c",
            waveHigh: "#4f97ff",
            waveGrid: "#9a9a9a",
            waveDownbeat: "#ffffff",
            wavePlayhead: "#ffffff",
            wavePlayheadCap: "#ffffff",
            cue1: "#d8001c",
            cue2: "#ff7a00",
            cue3: "#1f5ee0",
            cue4: "#ffbb00",
            cue5: "#00ae00",
            cue6: "#e01ba2",
            cue7: "#8a45e0",
            cue8: "#16b9d4",
        },
        sizes: { panelGap: 3, panelRadius: 3, controlRadius: 3, padRadius: 3, wavePlayedAlpha: 1 },
    },
};

/**
 * Pilot: blue-grey chrome with dark wells, deck A blue and deck B red on everything that
 * belongs to a deck (BPM, PLAY, waveform in three tones of the deck colour), both waveforms in
 * one band, the virtual platter, a fixed high-chroma cue set. ON is a NEUTRAL light fill: the
 * two deck colours are the only hues on the decks, so a lit toggle never fights the deck it
 * sits on (a blue ON on the red deck did).
 */
const PILOT: PackTokens = {
    mode: "dark",
    surface: "flat",
    density: "compact",
    radius: "sm",
    colors: {
        background: "oklch(0.209 0.006 271)", // ≈ #17181b
        foreground: "oklch(0.944 0.003 286)", // ≈ #ececee
        card: "oklch(0.306 0.009 277)", // ≈ #2e2f34
        "card-foreground": "oklch(0.944 0.003 286)",
        popover: "oklch(0.277 0.007 275)", // ≈ #27282c
        "popover-foreground": "oklch(0.944 0.003 286)",
        secondary: "oklch(0.261 0.008 275)", // ≈ #232428
        "secondary-foreground": "oklch(0.944 0.003 286)",
        muted: "oklch(0.261 0.008 275)",
        "muted-foreground": "oklch(0.777 0.006 286)", // ≈ #b6b6ba
        border: "oklch(0.414 0.01 278)", // ≈ #4a4b51
        input: "oklch(0.473 0.011 280)",
        primary: "oklch(0.874 0.003 286)", // ≈ #d5d5d7
        "primary-foreground": "oklch(0.188 0.004 286)", // ≈ #131315
        accent: "oklch(0.373 0.01 278)", // ≈ #3f4046
        "accent-foreground": "#ffffff",
        ring: "#45b4dc",
    },
    decks: { a: "#33add9", b: "#f76b7a", c: "#1fbda4", d: "#ee7d4f" },
    style: {
        look: "signature",
        layout: "pro",
        platter: true,
        waves: "overlay",
        colors: {
            well: "oklch(0.188 0.004 286)", // ≈ #131315
            waveBg: "oklch(0.177 0.004 265)", // ≈ #101113
            line: "oklch(0.191 0.006 271)", // ≈ #131417: dark inset lines
            faint: "oklch(0.713 0.006 286)", // ≈ #a2a2a6
            on: "oklch(0.874 0.003 286)",
            onFg: "oklch(0.188 0.004 286)",
            playFg: "oklch(0.16 0.004 271)",
            cue: "oklch(0.877 0.004 286)", // ≈ #d6d6d9
            alert: "#f4525a",
            waveGrid: "oklch(0.573 0.006 275)", // ≈ #77787c
            waveDownbeat: "oklch(0.861 0.007 277)", // ≈ #d0d1d6
            wavePlayhead: "oklch(0.861 0.007 277)",
            wavePlayheadCap: "oklch(0.861 0.007 277)",
            cue1: "#e01410",
            cue2: "#dc9410",
            cue3: "#3a46f0",
            cue4: "#d6d200",
            cue5: "#0fd216",
            cue6: "#de18d6",
            cue7: "#12cfd8",
            cue8: "#a22ae6",
        },
        sizes: { panelGap: 4, panelRadius: 3, controlRadius: 2, padRadius: 2, controlHeight: 26, wavePlayedAlpha: 1 },
    },
};

export const BUILTIN_SKINS: PackInfo[] = [
    skin(SKIN_MAINROOM, "Mainroom", "Black, flat greys and one blue. Familiar to rekordbox users; not affiliated with or endorsed by AlphaTheta.", MAINROOM),
    skin(SKIN_CRATE, "Crate", "Black wells in warm grey, spectrum waveform, platter. Familiar to Serato users; not affiliated with or endorsed by Serato.", CRATE),
    skin(SKIN_PILOT, "Pilot", "Blue deck, red deck, one waveform band. Familiar to VirtualDJ users; not affiliated with or endorsed by Atomix Productions.", PILOT),
    skin(SKIN_GLASS_CLASSIC, "Glass (classic)", "The Decks 1.x look: glass panels, violet accent, roomy controls.", GLASS_CLASSIC),
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
