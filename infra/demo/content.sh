#!/bin/bash
# Download the LEGAL demo library onto /srv/mixai/media (run on the VM: sudo -u '#1000' bash content.sh).
# Files are kept exactly as published (zips are only unpacked, nothing is re-encoded or re-tagged).
# Idempotent: existing files are skipped. Licences: infra/demo/README.md + /srv/mixai/media/ATTRIBUTION.md.
set -uo pipefail
M=/srv/mixai/media
TMP=/srv/mixai/tmp
mkdir -p "$M/films" "$M/shows" "$M/music" "$TMP"
fail=0

get() { # get <url> <dest file>
  local url="$1" dest="$2"
  [ -s "$dest" ] && { echo "skip  $dest"; return 0; }
  mkdir -p "$(dirname "$dest")"
  echo "fetch $dest"
  if curl -fsSL --retry 4 --retry-delay 5 --connect-timeout 20 -o "$dest.part" "$url"; then mv "$dest.part" "$dest"; else echo "FAIL  $url"; rm -f "$dest.part"; fail=1; fi
}
getzip() { # getzip <url> <dest file> — the zip holds exactly one media file; unpack it unchanged
  local url="$1" dest="$2"
  [ -s "$dest" ] && { echo "skip  $dest"; return 0; }
  local z="$TMP/$(basename "$dest").zip"
  get "$url" "$z" || return 0
  [ -s "$z" ] || return 0
  local inner
  inner=$(unzip -Z1 "$z" | grep -Ei '\.(mp4|mkv|mov|webm)$' | head -n1)
  if [ -z "$inner" ]; then echo "FAIL  no media in $z"; fail=1; return 0; fi
  mkdir -p "$(dirname "$dest")"
  unzip -p "$z" "$inner" > "$dest.part" && mv "$dest.part" "$dest" && rm -f "$z"
}
IA=https://archive.org/download
B=https://download.blender.org

# ── Films (Blender open movies + Caminandes) ────────────────────────────────
getzip "$B/demo/movies/BBB/bbb_sunflower_1080p_30fps_normal.mp4.zip" "$M/films/Big Buck Bunny (2008)/Big Buck Bunny (2008).mp4"
get    "$B/durian/movies/Sintel.2010.1080p.mkv"                       "$M/films/Sintel (2010)/Sintel (2010).mkv"
getzip "$B/demo/movies/ToS/tears_of_steel_1080p.mov.zip"              "$M/films/Tears of Steel (2012)/Tears of Steel (2012).mov"
get    "$B/demo/movies/ToS/subtitles/TOS-en.srt"                      "$M/films/Tears of Steel (2012)/Tears of Steel (2012).en.srt"
get    "$B/demo/movies/ToS/subtitles/TOS-de.srt"                      "$M/films/Tears of Steel (2012)/Tears of Steel (2012).de.srt"
get    "$B/demo/movies/ToS/subtitles/TOS-fr-orig.srt"                 "$M/films/Tears of Steel (2012)/Tears of Steel (2012).fr.srt"
get    "$B/ED/elephantsdream-1024-h264-st-aac.mov"                    "$M/films/Elephants Dream (2006)/Elephants Dream (2006).mov"
get    "$IA/CosmosLaundromatFirstCycle/Cosmos%20Laundromat%20-%20First%20Cycle%20%281080p%29.mp4" "$M/films/Cosmos Laundromat (2015)/Cosmos Laundromat (2015).mp4"
get    "$IA/agent327operationbarbershop/agent327.mkv"                 "$M/films/Agent 327 Operation Barbershop (2017)/Agent 327 Operation Barbershop (2017).mkv"
get    "$IA/spring_blenderopenmovie/Spring%20-%20Blender%20Open%20Movie%20-%20YouTube.mkv" "$M/films/Spring (2019)/Spring (2019).mkv"
get    "$IA/sprite-fright/Sprite%20Fright%20-%20Open%20Movie%20by%20Blender%20Studio-804p.mp4" "$M/films/Sprite Fright (2021)/Sprite Fright (2021).mp4"
get    "$IA/Caminandes1LlamaDrama/01_llama_drama_1080p.mp4"           "$M/films/Caminandes Llama Drama (2013)/Caminandes Llama Drama (2013).mp4"
get    "$IA/Caminandes2GranDillama/02_gran_dillama_1080p.mp4"         "$M/films/Caminandes Gran Dillama (2013)/Caminandes Gran Dillama (2013).mp4"
get    "$IA/CaminandesLlamigos/Caminandes_%20Llamigos-1080p.mp4"      "$M/films/Caminandes Llamigos (2016)/Caminandes Llamigos (2016).mp4"

# ── Show: The Beverly Hillbillies (1962) — US public-domain episodes (copyright not renewed) ────────
S="$M/shows/The Beverly Hillbillies"
get "$IA/Beverly_Hillbillies_Ep01_The_Clampetts_Strike_Oil/BH01_The_Clampetts_Strike_Oil.mp4" "$S/Season 01/The Beverly Hillbillies - S01E01 - The Clampetts Strike Oil.mp4"
get "$IA/Beverly_Hillbillies_Ep02_Getting_Settled/BH02_Getting_Settled.mp4"                   "$S/Season 01/The Beverly Hillbillies - S01E02 - Getting Settled.mp4"
get "$IA/TheBeverlyHillbillies-JedBuysStock-Ep.1x05/TheBeverlyHillbillies105-JedBuysStock_512kb.mp4" "$S/Season 01/The Beverly Hillbillies - S01E05 - Jed Buys Stock.mp4"
get "$IA/Beverly_Hillbillies_Ep06_Trick_Or_Treat/BH06_Trick_Or_Treat.mp4"                     "$S/Season 01/The Beverly Hillbillies - S01E06 - Trick or Treat.mp4"
get "$IA/Beverly_Hillbillies_Ep07_The_Servants/BH07_The_Servants.mp4"                         "$S/Season 01/The Beverly Hillbillies - S01E07 - The Servants.mp4"
get "$IA/TheBeverlyHillbillies-JedGetsTheMisery-Ep2x01/TheBeverlyHillbillies201-JedGetsTheMisery_512kb.mp4" "$S/Season 02/The Beverly Hillbillies - S02E01 - Jed Gets the Misery.mp4"
get "$IA/s02e03_Grannys_Garden/s02e03_Grannys_Garden.mp4"                                     "$S/Season 02/The Beverly Hillbillies - S02E03 - Granny's Garden.mp4"
get "$IA/TheBeverlyHillbillies-EllyNeedsAMaw-Ep2x12/TheBeverlyHillbillies212-EllyNeedsAMaw_512kb.mp4" "$S/Season 02/The Beverly Hillbillies - S02E12 - Elly Needs a Maw.mp4"

# ── Music (CC BY / CC BY-ND, unmodified files) ──────────────────────────────
T="$M/music/Joram Letwory/Tears of Steel (Original Soundtrack)"
for f in "01 40 years later" "02 The dome" "03 The battle" "04 End credits"; do
  get "$B/demo/movies/ToS/Tears-Of-Steel-OST/${f// /%20}.mp3" "$T/$f.mp3"
done
E="$M/music/Jan Morgenstern/Elephants Dream (Soundtrack)"
for f in 1-TheWires 2-TypewriterDance 3-TheSafestPlace 4-EmoCreates 5-EndTitle 6-TeaserMusic 7-Ambience; do
  get "$B/ED/$f.mp3" "$E/$f.mp3"
done
get "$B/ED/cover.jpg" "$E/cover.jpg"
K="$M/music/Kevin MacLeod/incompetech Selection"
for f in "Monkeys Spinning Monkeys" "Sneaky Snitch" "Fluffing a Duck" "Carefree" "Wallpaper" "Local Forecast - Elevator" "Investigations" "Life of Riley"; do
  get "https://incompetech.com/music/royalty-free/mp3-royaltyfree/${f// /%20}.mp3" "$K/$f.mp3"
done

rmdir "$TMP" 2>/dev/null || true
cp -f /srv/mixai/app/ATTRIBUTION.md "$M/ATTRIBUTION.md" 2>/dev/null || true
for d in films shows music; do cp -f "$M/ATTRIBUTION.md" "$M/$d/ATTRIBUTION.md" 2>/dev/null || true; done
echo "== inventory"
du -sh "$M"/films "$M"/shows "$M"/music
find "$M" -type f \( -name '*.mp4' -o -name '*.mkv' -o -name '*.mov' -o -name '*.mp3' \) | wc -l
echo "CONTENT_FAIL=$fail"
echo CONTENTDONE
