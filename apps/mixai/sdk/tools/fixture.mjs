// Test-only key material and sample pack. The seed is PUBLIC on purpose (derived from a fixed
// string) so the fixture is reproducible; it is a community key, never trusted as official.
import { createHash } from "node:crypto";
import { renderPreview } from "../lib/png.mjs";

export const TEST_SEED = createHash("sha256").update("mixai-sdk-public-test-key-v1").digest();
export const TEST_KEY_ID = "mixai-sdk-test";

const json = (v) => Buffer.from(JSON.stringify(v, null, 2) + "\n");

export function sampleFiles() {
    const colors = {
        background: "oklch(0.16 0.02 270)",
        foreground: "oklch(0.96 0.01 270)",
        primary: "oklch(0.72 0.18 300)",
        "primary-foreground": "oklch(0.15 0.02 300)",
        "deck-a": "#00e5ff",
    };
    const layout = {
        v: 1,
        id: "main",
        name: "Main",
        columns: [5, 3, 5],
        rows: [9, 2],
        areas: [
            { panel: "deckA", col: 0, row: 0, rowSpan: 2 },
            { panel: "mixer", col: 1, row: 0 },
            { panel: "crossfader", col: 1, row: 1 },
            { panel: "deckB", col: 2, row: 0, rowSpan: 2 },
        ],
    };
    return new Map([
        ["manifest.json", json({ v: 1, id: "com.example.test.sample", name: "Sample", version: "1.0.0", kind: "bundle", author: "MixAI SDK tests", description: "Fixture for the Rust cross-check", pro: false, tokens: "tokens.json", layouts: ["layouts/main.json"], preview: "assets/preview.png" })],
        ["tokens.json", json({ mode: "dark", surface: "glass", radius: "md", colors, decks: { b: "oklch(0.7 0.2 30 / 0.9)" } })],
        ["layouts/main.json", json(layout)],
        ["assets/preview.png", renderPreview(colors, layout, 160, 90)],
    ]);
}

/** Every `style` field a manifest-v2 skin may set (one value per colour and size key). */
export const SAMPLE_STYLE = {
    look: "classic",
    platter: true,
    layout: "pro-vertical",
    waves: "overlay",
    colors: {
        well: "#0b0d0f", waveBg: "#000000", line: "#ffffff22", faint: "#888888", on: "#00d37f", onFg: "#001b08",
        play: "#00ff88", playFg: "#000000", cue: "#ff8800", alert: "#ff2b2b",
        waveLow: "oklch(0.6 0.2 250)", waveMid: "#33cc88", waveHigh: "#ffffffcc", waveGrid: "#ffffff33",
        waveDownbeat: "#ffffff88", wavePlayhead: "#ffffff", wavePlayheadCap: "#ff0000",
        cue1: "#ff0000", cue2: "#ff8800", cue3: "#ffff00", cue4: "#00ff00", cue5: "#00ffff", cue6: "#0000ff", cue7: "#ff00ff", cue8: "#ffffff",
    },
    sizes: { panelGap: 6, panelRadius: 0, panelPad: 16, controlRadius: 2.5, padRadius: 12, controlHeight: 24, titlebarHeight: 28, wavePlayedAlpha: 0.45 },
};

/** A manifest-v2 skin with a full `style` block (fixture for the Rust cross-check). */
export function styleSampleFiles() {
    const colors = { background: "oklch(0.14 0.01 150)", foreground: "oklch(0.96 0.01 150)", primary: "#00d37f", "primary-foreground": "#001b08" };
    return new Map([
        ["manifest.json", json({ v: 2, id: "com.example.test.style", name: "Style sample", version: "1.0.0", kind: "skin", author: "MixAI SDK tests", description: "Manifest v2 fixture for the Rust cross-check", pro: false, tokens: "tokens.json", preview: "assets/preview.png" })],
        ["tokens.json", json({ mode: "dark", surface: "solid", colors, style: SAMPLE_STYLE })],
        ["assets/preview.png", renderPreview(colors, null, 160, 90)],
    ]);
}
