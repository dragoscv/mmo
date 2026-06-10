#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 10024 dragos@127.0.0.1"
$SSH 'cd /home/dragos/companion-dev; cat > test-va.js <<"EOF"
const path = require("path");
const { LinuxVirtualAudioAdapter } = require("./dist/audio/virtual-devices/linux.js");
const a = new LinuxVirtualAudioAdapter();
const { execFileSync } = require("child_process");
function pa(args) { return execFileSync("pactl", args, { encoding: "utf8" }); }
function listSinks() { return pa(["list", "short", "sinks"]).split("\n").filter(l => l.includes("mmo_va_")); }
(async () => {
  console.log("PROBE:", JSON.stringify(await a.probe()));
  const m = await a.create({ name: "MMO-Master", topology: "independent", channels: 2, sampleRate: 48000 });
  console.log("CREATE A:", JSON.stringify(m));
  const c = await a.create({ name: "MMO-Cue", topology: "independent", channels: 2, sampleRate: 48000 });
  console.log("CREATE B:", JSON.stringify(c));
  const lb = await a.create({ name: "MMO-Loopback", topology: "loopback", channels: 2, sampleRate: 48000 });
  console.log("CREATE LB:", JSON.stringify(lb));
  console.log("LIST:", JSON.stringify(await a.list()));
  console.log("PA SINKS:", listSinks());
  console.log("RENAME B:", JSON.stringify(await a.rename(c.id, "MMO-Cue-Renamed")));
  console.log("PA SINKS AFTER RENAME:", listSinks());
  console.log("DISABLE A:", JSON.stringify(await a.setEnabled(m.id, false)));
  console.log("PA SINKS AFTER DISABLE:", listSinks());
  await a.remove(m.id);
  await a.remove(c.id);
  await a.remove(lb.id);
  console.log("PA SINKS FINAL:", listSinks());
})().catch(e => { console.error("FAIL:", e); process.exit(1); });
EOF
node test-va.js'
