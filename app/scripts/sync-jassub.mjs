// Copies JASSUB worker + wasm into public/jassub so the player can load
// them at runtime from a same-origin URL. Runs as a postinstall hook —
// silently no-ops when JASSUB is not installed (it's an optional dep).
//
// Source:  node_modules/jassub/dist/{jassub-worker.js,jassub-worker.wasm,jassub-worker-modern.wasm}
// Target:  public/jassub/

import { existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const src = join(root, "node_modules", "jassub", "dist");
const dst = join(root, "public", "jassub");

if (!existsSync(src)) {
    // JASSUB not installed — that's fine, the renderer lazy-imports and gracefully fails.
    process.exit(0);
}

mkdirSync(dst, { recursive: true });

const wanted = readdirSync(src).filter(f => /^jassub-worker(\.|-modern)/.test(f) || f === "default.woff2");
let copied = 0;
for (const f of wanted) {
    copyFileSync(join(src, f), join(dst, f));
    copied++;
}
console.log(`[sync-jassub] copied ${copied} file(s) into public/jassub/`);
