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
