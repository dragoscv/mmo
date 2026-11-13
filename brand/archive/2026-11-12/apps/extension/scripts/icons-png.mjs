// Rasterise icons/*.svg -> icons/*.png (Chrome Web Store and Edge Add-ons reject SVG manifest icons).
// Usage: node scripts/icons-png.mjs   (sharp is resolved from apps/web/node_modules; no extension dependency)
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..");
const require = createRequire(path.resolve(ext, "../web/package.json"));
const sharp = require("sharp");

for (const size of [16, 32, 48, 128]) {
    const svg = readFileSync(path.join(ext, "icons", `icon${size}.svg`));
    const png = await sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();
    writeFileSync(path.join(ext, "icons", `icon${size}.png`), png);
    console.log(`icons/icon${size}.png ${png.length} B`);
}
