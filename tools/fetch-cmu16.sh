#!/usr/bin/env bash
# Download the CMU subject 16 locomotion takes (Bruce Hahne's cgspeed BVH conversion) used by study 09.
# The raw BVH (~11 MB) is not committed; tools/build-mm-db.mjs turns it into the shipped database.
#
#   bash tools/fetch-cmu16.sh [dest=.cache/cmu16]
set -euo pipefail
dest="${1:-.cache/cmu16}"
base="https://raw.githubusercontent.com/una-dinosauria/cmu-mocap/master/data/016"
takes="02 06 08 09 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58"
mkdir -p "$dest"
for n in $takes; do
  f="$dest/16_$n.bvh"
  [ -s "$f" ] && continue
  for attempt in 1 2 3 4; do
    if curl -fsS --max-time 60 -o "$f.part" "$base/16_$n.bvh"; then mv "$f.part" "$f"; break; fi
    sleep $((attempt * 2))
  done
  [ -s "$f" ] || { echo "failed: 16_$n" >&2; exit 1; }
done
echo "$(ls "$dest"/*.bvh | wc -l) takes in $dest"
