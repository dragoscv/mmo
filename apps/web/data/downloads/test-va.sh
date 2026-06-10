#!/usr/bin/env bash
set -e
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 10022 dragos@127.0.0.1"
$SSH 'export PATH=/Users/dragos/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; cd /Users/dragos/companion-dev; cat > test-va.js <<"EOF"
const path = require("path");
const { MacOSVirtualAudioAdapter } = require("./dist/audio/virtual-devices/macos.js");
const pkg = path.resolve(__dirname, "assets/virtual-audio/macos/BlackHole.16ch.pkg");
const a = new MacOSVirtualAudioAdapter(pkg);
(async () => {
  console.log("PROBE:", JSON.stringify(await a.probe()));
  const m = await a.create({ name: "MMO-Master", topology: "independent", channels: 2, sampleRate: 48000 });
  console.log("CREATE A:", JSON.stringify(m));
  const c = await a.create({ name: "MMO-Cue", topology: "independent", channels: 2, sampleRate: 48000 });
  console.log("CREATE B:", JSON.stringify(c));
  console.log("LIST:", JSON.stringify(await a.list()));
  console.log("RENAME:", JSON.stringify(await a.rename(c.id, "MMO-Cue-Renamed")));
  console.log("DISABLE:", JSON.stringify(await a.setEnabled(m.id, false)));
  await a.remove(m.id);
  console.log("LIST AFTER REMOVE:", JSON.stringify(await a.list()));
  // Loopback case (no admin needed for create() bookkeeping)
  const lb = await a.create({ name: "MMO-Loopback", topology: "loopback", channels: 2, sampleRate: 48000 });
  console.log("CREATE LB:", JSON.stringify(lb));
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
EOF
node test-va.js'
