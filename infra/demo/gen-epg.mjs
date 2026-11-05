// Writes <out>/demo.m3u + <out>/epg.xml for the two looping demo channels (48 h ahead, 6 h back).
// Programme blocks follow each loop's real start (<out>/<n>/started) and the film duration (ffprobe).
// Usage (inside the mmo-server image): node gen-epg.mjs /out     env DEMO_HOST=demo.mixai.ro
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2] ?? "/out";
const host = (process.env.DEMO_HOST || "demo.mixai.ro").split(",")[0].trim();
const CHANNELS = [
  { n: 1, id: "mixai-demo-1", name: "MixAI Demo 1", file: "/media/films/Big Buck Bunny (2008)/Big Buck Bunny (2008).mp4",
    title: "Big Buck Bunny", desc: "Blender Foundation open movie (2008). CC BY 3.0, (c) Blender Foundation, peach.blender.org", category: "Animation" },
  { n: 2, id: "mixai-demo-2", name: "MixAI Demo 2", file: "/media/films/Sintel (2010)/Sintel (2010).mkv",
    title: "Sintel", desc: "Blender Foundation open movie (2010). CC BY 3.0, (c) Blender Foundation, durian.blender.org", category: "Animation" },
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14) + " +0000";
function durationSec(file) {
  try {
    const s = execFileSync(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim();
    const d = Number(s);
    return Number.isFinite(d) && d > 0 ? d : 600;
  } catch { return 600; }
}

const now = Date.now();
let m3u = `#EXTM3U x-tvg-url="https://${host}/demo-channel/epg.xml"\n`;
let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="mixai-demo">\n`;
const progs = [];
for (const c of CHANNELS) {
  m3u += `#EXTINF:-1 tvg-id="${c.id}" tvg-name="${c.name}" tvg-chno="${c.n}" group-title="MixAI Demo",${c.name}\n`;
  m3u += `https://${host}/demo-channel/${c.n}/index.m3u8\n`;
  xml += `  <channel id="${c.id}"><display-name>${esc(c.name)}</display-name></channel>\n`;
  let started = now;
  try { started = Number(fs.readFileSync(path.join(out, String(c.n), "started"), "utf8").trim()) * 1000 || now; } catch { /* not started yet */ }
  const len = durationSec(c.file) * 1000;
  // First block boundary at or before (now - 6 h), aligned to the loop start.
  const from = now - 6 * 3600_000;
  let t = started - Math.ceil((started - from) / len) * len;
  let ep = 1;
  while (t < now + 48 * 3600_000) {
    progs.push(`  <programme start="${stamp(t)}" stop="${stamp(t + len)}" channel="${c.id}"><title lang="en">${esc(c.title)}</title>` +
      `<sub-title lang="en">Loop ${ep}</sub-title><desc lang="en">${esc(c.desc)}</desc><category lang="en">${c.category}</category></programme>`);
    t += len; ep++;
  }
}
xml += progs.join("\n") + "\n</tv>\n";
const write = (name, body) => { const p = path.join(out, name); fs.writeFileSync(p + ".tmp", body); fs.renameSync(p + ".tmp", p); };
write("demo.m3u", m3u);
write("epg.xml", xml);
console.log(`epg: ${progs.length} programmes, host=${host}`);
