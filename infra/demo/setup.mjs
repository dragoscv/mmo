// One-shot demo configuration, run INSIDE the mmo-server container (loopback, no X-Forwarded-For = demo admin):
//   sudo docker exec -i -e DEMO_HOST=<host> mmo-server node - < setup.mjs
// Idempotent: scans video roots, ingests the music library, names the default profile "Reviewer",
// adds a "Kids" profile and a PIN-protected "Parent" profile, registers the demo Live TV source. Reads the
// device token from /data/config.json and never prints it.
import fs from "node:fs";

const BASE = "http://127.0.0.1:17899";
const token = JSON.parse(fs.readFileSync("/data/config.json", "utf8")).deviceToken;
if (!token) throw new Error("no deviceToken in /data/config.json");
const host = process.env.DEMO_HOST || "demo.mixai.ro";
const H = { "x-device-token": token, "content-type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body, extra = {}) {
  const r = await fetch(BASE + path, { method, headers: { ...H, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

// 1. Video roots → background video scan jobs (TMDB matching runs in the media hooks).
const vs = await api("POST", "/video/scan", {});
console.log("video/scan", vs.status, `files=${vs.json.files?.length ?? 0} pending=${vs.json.pendingRoots?.length ?? 0}`);

// 2. Music: audio scan job → ingest the parsed tracks for the local user (what the web app does on a paired PC).
const userId = JSON.parse(fs.readFileSync("/data/config.json", "utf8")).userId || "local";
const existing = await api("GET", "/library/tracks?limit=1", undefined, { "x-user-id": userId });
const have = existing.json?.total ?? existing.json?.tracks?.length ?? 0;
if (!have) {
  const job = await api("POST", "/scan", { folder: "/media/music", kind: "music" });
  console.log("scan music", job.status, job.json.jobId ?? job.json.error);
  for (let i = 0; i < 120 && job.json.jobId; i++) {
    await sleep(2000);
    const j = (await api("GET", `/scan/jobs/${job.json.jobId}`)).json.job;
    if (j?.status === "complete") {
      const tracks = j.tracks ?? [];
      const ing = await api("POST", "/library/tracks/ingest", { tracks }, { "x-user-id": userId });
      console.log("ingest", ing.status, JSON.stringify(ing.json));
      await api("POST", `/scan/jobs/${job.json.jobId}/ack`);
      break;
    }
    if (j?.status === "error") { console.log("scan error", j.error); break; }
  }
} else console.log("music already ingested");

// 3. Profiles: default → "Reviewer" (adult, no PIN); "Kids" (kid, max age 12) exercises the kids gate.
const profiles = (await api("GET", "/media/profiles")).json.profiles ?? [];
const def = profiles.find((p) => p.id === "default");
if (def && def.name !== "Reviewer") console.log("rename default", (await api("PATCH", "/media/profiles/default", { name: "Reviewer", color: "violet" })).status);
if (!profiles.some((p) => p.name === "Kids")) console.log("create Kids", (await api("POST", "/media/profiles", { name: "Kids", kind: "kid", maxAge: 12, color: "amber" })).status);
// "Parent" (adult, PIN) shows store reviewers the lock and the PIN pad. The PIN is public on purpose: it is in the
// review notes (docs/store/review-notes.md). "Reviewer" stays without a PIN, every store's notes say to pick it.
const DEMO_PARENT_PIN = "1234";
if (!profiles.some((p) => p.name === "Parent")) console.log("create Parent", (await api("POST", "/media/profiles", { name: "Parent", kind: "adult", pin: DEMO_PARENT_PIN, color: "blue" })).status);

// 4. Live TV: the two looping demo channels (M3U + XMLTV served by Caddy).
const sources = (await api("GET", "/livetv/sources")).json.sources ?? [];
const url = `https://${host}/demo-channel/demo.m3u`;
const xmltvUrl = `https://${host}/demo-channel/epg.xml`;
const cur = sources.find((s) => s.name === "MixAI Demo channels");
if (!cur) {
  const c = await api("POST", "/livetv/sources", { kind: "m3u", name: "MixAI Demo channels", url, xmltvUrl, refreshHours: 6 });
  console.log("livetv source", c.status, c.json.id ?? c.json.error);
} else if (cur.url !== url) {
  console.log("livetv source update", (await api("PATCH", `/livetv/sources/${cur.id}`, { url, xmltvUrl })).status);
}
await sleep(4000);
const sid = ((await api("GET", "/livetv/sources")).json.sources ?? []).find((s) => s.name === "MixAI Demo channels")?.id;
if (sid) {
  const r = await api("POST", `/livetv/sources/${sid}/refresh`);
  console.log("livetv refresh", r.status, JSON.stringify(r.json).slice(0, 300));
}
console.log("SETUPDONE");
