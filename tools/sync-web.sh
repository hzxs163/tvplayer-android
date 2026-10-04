#!/usr/bin/env bash
# 把 tvplayer-cf 的静态文件原样同步进 APK 资源，一个字节都不改。
# 用法：bash tools/sync-web.sh [tvplayer-cf 路径]
set -e
cd "$(dirname "$0")/.."

SRC="${1:-../tvplayer-cf}"
DST="app/src/main/assets"
FILES="index.html script.js style.css hls.min.js manifest.json sources.json sw.js"

[ -d "$SRC" ] || { echo "找不到源目录: $SRC"; exit 1; }
mkdir -p "$DST"

for f in $FILES; do
  cp -p "$SRC/$f" "$DST/$f"
done
rm -rf "$DST/icons"
cp -rp "$SRC/icons" "$DST/icons"

echo "同步完成，逐文件核对 sha256："
fail=0
for f in $FILES; do
  a=$(sha256sum "$SRC/$f" | cut -c1-16)
  b=$(sha256sum "$DST/$f" | cut -c1-16)
  if [ "$a" = "$b" ]; then
    echo "  SAME  $f  $a"
  else
    echo "  DIFF  $f  $a vs $b"
    fail=1
  fi
done
[ "$fail" = 0 ] || { echo "有文件不一致，已中止"; exit 1; }
echo "全部一致。记得把 mipmap 图标也同步：cp assets/icons/icon-192.png res/mipmap-xxhdpi/ic_launcher.png"
