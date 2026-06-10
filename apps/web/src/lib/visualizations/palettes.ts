import type { PaletteName } from "./types";

export const PALETTES: Record<PaletteName, string[]> = {
    neon: ["#ff00ff", "#00ffff", "#ff0080", "#80ff00", "#0080ff"],
    fire: ["#ff4500", "#ff6a00", "#ff9500", "#ffcc00", "#ffe066"],
    ocean: ["#006994", "#0099cc", "#00bfff", "#40e0d0", "#7fffd4"],
    sunset: ["#ff6b6b", "#ffa07a", "#ffd700", "#ff8c69", "#ff4500"],
    matrix: ["#00ff00", "#00cc00", "#009900", "#33ff33", "#66ff66"],
    arctic: ["#e0f7fa", "#80deea", "#4dd0e1", "#00bcd4", "#0097a7"],
    candy: ["#ff69b4", "#ff1493", "#da70d6", "#ff6eb4", "#ffb6c1"],
    midnight: ["#191970", "#4169e1", "#6495ed", "#1e90ff", "#87ceeb"],
    forest: ["#228b22", "#32cd32", "#006400", "#90ee90", "#3cb371"],
    lava: ["#ff0000", "#ff4500", "#ff6600", "#cc3300", "#990000"],
    electric: ["#7b2ff7", "#c471f5", "#f64f59", "#12c2e9", "#f7971e"],
    pastel: ["#ffb3ba", "#baffc9", "#bae1ff", "#ffffba", "#e8baff"],
    retrowave: ["#ff2a6d", "#05d9e8", "#d600ff", "#ff6c11", "#01012b"],
    aurora: ["#00ff87", "#60efff", "#ff00ff", "#7b2ff7", "#00ffc8"],
    copper: ["#b87333", "#da8a67", "#e8a87c", "#c19a6b", "#cd7f32"],
    cyberpunk: ["#f72585", "#b5179e", "#7209b7", "#560bad", "#3a0ca3"],
    gold: ["#ffd700", "#ffec8b", "#daa520", "#b8860b", "#cd950c"],
    monochrome: ["#ffffff", "#cccccc", "#999999", "#666666", "#e0e0e0"],
    rainbow: ["#ff0000", "#ff8800", "#ffff00", "#00ff00", "#0088ff", "#8800ff"],
    vapor: ["#ff71ce", "#01cdfe", "#05ffa1", "#b967ff", "#fffb96"],
};

export const PALETTE_NAMES = Object.keys(PALETTES) as PaletteName[];

// 5 core palettes used for variant generation
export const VARIANT_PALETTES: PaletteName[] = ["neon", "fire", "ocean", "sunset", "cyberpunk"];

export function getPalette(name: PaletteName): string[] {
    return PALETTES[name];
}
