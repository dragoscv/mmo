// Regenerates docs/mixai-design-tracker.csv from the canonical .md (WP rows only; other CSV lines kept).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const md = readFileSync(join(root, "docs/mixai-design-tracker.md"), "utf8");
const csvP = join(root, "docs/mixai-design-tracker.csv");
const old = readFileSync(csvP, "utf8");
// keep the non-WP sections of the old CSV (decisions, questions) — everything whose id isn't WPx-yy
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
const rows = [];
for (const line of md.split(/\r?\n/)) {
  const m = line.match(/^\| (WP\d{1,2}-\d\d) \| (.*) \|\s*$/);
  if (!m) continue;
  const cells = m[2].split(" | ").map((c) => c.trim());
  // MD row shapes seen: [type, surface, title, status] or [title, status] or [type,surface,title,status,notes]
  let type = "", surface = "", title = "", status = "", notes = "";
  if (cells.length >= 4) { [type, surface, title, status, notes = ""] = cells; }
  else if (cells.length === 3) { [surface, title, status] = cells; }
  else if (cells.length === 2) { [title, status] = cells; }
  else { title = cells[0] ?? ""; }
  const st = status.match(/^(done|doing|blocked|dropped|todo)\b/i)?.[1]?.toLowerCase() ?? (/\*\*blocked/.test(status) ? "blocked" : "todo");
  const note = status.replace(/^(done|doing|blocked|dropped|todo)\b\s*/i, "").trim() || notes;
  rows.push([m[1], type, surface, title, st, "agent", note]);
}
const keep = old.split(/\r?\n/).filter((l) => l && !/^"?WP\d{1,2}-\d\d"?,/.test(l) && !/^ID,/i.test(l) && !/^id,type,surface/.test(l));
const header = "id,type,surface,title,status,owner,decision_or_notes";
const outLines = [header, ...rows.map((r) => r.map(q).join(","))];
if (keep.length) outLines.push("", ...keep);
writeFileSync(csvP, outLines.join("\n") + "\n");
const counts = {}; rows.forEach((r) => (counts[r[4]] = (counts[r[4]] || 0) + 1));
console.log("rows", rows.length, counts);
console.log("todo:", rows.filter((r) => r[4] === "todo").map((r) => r[0]).join(", "));
console.log("kept extra lines:", keep.length);
