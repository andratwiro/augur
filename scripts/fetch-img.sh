#!/usr/bin/env bash
# Internal tooling — never published. Download a stock photo and emit an
# optimized WebP at a target width, stepping quality down until it fits a byte
# budget. Keeps prototype/page image weight small + self-contained for real users.
#
# Usage: scripts/fetch-img.sh <url> <out.webp> <width> <maxKB>
#   e.g. scripts/fetch-img.sh "https://images.pexels.com/.../x.jpeg?w=1600" \
#          pages/homepage/img/hero.webp 1600 150
set -euo pipefail
url="$1"; out="$2"; width="${3:-1600}"; maxkb="${4:-150}"
tmp="$(mktemp -t fetchimg).src"
trap 'rm -f "$tmp"' EXIT

curl -sL --max-time 40 "$url" -o "$tmp"
if ! file "$tmp" | grep -qiE 'image|JPEG|PNG|WebP'; then
  echo "FAIL  $out  (not an image — URL bad?)" >&2; exit 1
fi
mkdir -p "$(dirname "$out")"

for q in 78 70 62 55 48 42 36; do
  cwebp -quiet -q "$q" -m 6 -resize "$width" 0 "$tmp" -o "$out" 2>/dev/null || \
  cwebp -quiet -q "$q" -m 6 "$tmp" -o "$out" 2>/dev/null
  kb=$(( ( $(stat -f%z "$out") + 1023 ) / 1024 ))
  if [ "$kb" -le "$maxkb" ]; then
    echo "OK    $out  ${width}px  q$q  ${kb}KB"; exit 0
  fi
done
echo "WARN  $out  ${width}px  q36  ${kb}KB  (over ${maxkb}KB budget)"
