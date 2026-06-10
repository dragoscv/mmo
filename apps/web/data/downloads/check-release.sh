#!/usr/bin/env bash
set -e
curl -sf https://api.github.com/repos/dragoscv/mmo/releases/latest > /tmp/rel.json
echo "TAG: $(python3 -c 'import json;print(json.load(open("/tmp/rel.json"))["tag_name"])')"
echo "PUBLISHED: $(python3 -c 'import json;print(json.load(open("/tmp/rel.json"))["published_at"])')"
echo "ASSETS:"
python3 -c 'import json
d=json.load(open("/tmp/rel.json"))
for a in d["assets"]:
    print(" ", a["size"], a["name"], a["browser_download_url"])'
