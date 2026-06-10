#!/usr/bin/env bash
curl -sf https://api.github.com/repos/dragoscv/mmo/releases > /tmp/rels.json
python3 << 'EOF'
import json
rels = json.load(open("/tmp/rels.json"))
for r in rels[:15]:
    print(r["tag_name"], "|", r.get("published_at"), "|", r.get("name"))
EOF
