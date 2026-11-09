#!/bin/bash
# Rebuild the vendored core; never installs a system-wide runtime or changes shell startup files.
set -euo pipefail
VG_REPO_ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
VG_VENDOR="$VG_REPO_ROOT/vendor/ffmpeg-core"
VG_MANIFEST="$VG_VENDOR/manifest.json"
VG_MODE="${1:-build}"
case "$VG_MODE" in build|--source-only) ;; *) echo "Usage: $0 [--source-only]" >&2; exit 2;; esac
for VG_COMMAND in python3 curl tar patch make; do
  command -v "$VG_COMMAND" >/dev/null || { echo "Missing build tool: $VG_COMMAND" >&2; exit 1; }
done
mkdir -p "$VG_REPO_ROOT/artifacts/release"
VG_BUILD_ROOT="$(mktemp -d "$VG_REPO_ROOT/artifacts/core-build.XXXXXX")"
printf 'Build dependencies and logs: %s\n' "$VG_BUILD_ROOT"
mkdir -p "$VG_BUILD_ROOT/archives"

# Exact upstream source hashes and project patch hashes are checked before execution.
python3 - "$VG_MANIFEST" "$VG_VENDOR" > "$VG_BUILD_ROOT/sources.tsv" <<'PY'
import hashlib,json,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text())
for name,digest in m['patches'].items():
    actual=hashlib.sha256((Path(sys.argv[2])/'source/patches'/name).read_bytes()).hexdigest()
    if actual != digest: raise SystemExit('Patch checksum mismatch: '+name)
for name,item in m['sources'].items():
    print(name+'\t'+item['url']+'\t'+item['sha256']+'\t'+item['commit'])
PY
while IFS=$'\t' read -r VG_NAME VG_URL VG_SHA VG_COMMIT; do
  VG_ARCHIVE="$VG_BUILD_ROOT/archives/$VG_NAME.tar.gz"
  if [ -f "$VG_REPO_ROOT/archives/$VG_NAME.tar.gz" ]; then
    cp "$VG_REPO_ROOT/archives/$VG_NAME.tar.gz" "$VG_ARCHIVE"
  else
    curl --fail --location --silent --show-error --retry 2 "$VG_URL" --output "$VG_ARCHIVE"
  fi
  python3 - "$VG_ARCHIVE" "$VG_SHA" <<'PY'
import hashlib,sys
from pathlib import Path
if hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest()!=sys.argv[2]:
    raise SystemExit('Source checksum mismatch: '+sys.argv[1])
PY
  mkdir -p "$VG_BUILD_ROOT/$VG_NAME"
  tar -xzf "$VG_ARCHIVE" --strip-components=1 -C "$VG_BUILD_ROOT/$VG_NAME"
done < "$VG_BUILD_ROOT/sources.tsv"

if [ "$VG_MODE" = build ]; then
  (
    cd "$VG_BUILD_ROOT/emsdk"
    ./emsdk install 3.1.40
    ./emsdk activate 3.1.40
  ) > "$VG_BUILD_ROOT/emsdk.log" 2>&1
  # emsdk changes only this process environment; no user profile is edited.
  source "$VG_BUILD_ROOT/emsdk/emsdk_env.sh" >/dev/null 2>&1
  cd "$VG_BUILD_ROOT/ffmpeg"
  for VG_PATCH in wasm-wrapper.patch CVE-2026-107695.patch CVE-2026-107697.patch CVE-2026-107678.patch hevc-count-bound.patch disable-pssh.patch parser-remux-dimensions.patch; do
    patch -p1 < "$VG_VENDOR/source/patches/$VG_PATCH"
  done
  VG_CONFIGURE=()
  while IFS= read -r VG_ARG; do [ -z "$VG_ARG" ] || VG_CONFIGURE+=("$VG_ARG"); done < "$VG_VENDOR/source/configure.args"
  VG_LINK=()
  while IFS= read -r VG_ARG; do [ -z "$VG_ARG" ] || VG_LINK+=("$VG_ARG"); done < "$VG_VENDOR/source/link.args"
  emconfigure ./configure "${VG_CONFIGURE[@]}" > "$VG_BUILD_ROOT/configure.log" 2>&1
  emmake make -j8 > "$VG_BUILD_ROOT/compile.log" 2>&1
  emcc "${VG_LINK[@]}" --pre-js "$VG_BUILD_ROOT/wrapper/src/bind/ffmpeg/bind.js" \
    fftools/cmdutils.c fftools/ffmpeg.c fftools/ffmpeg_filter.c fftools/ffmpeg_hw.c \
    fftools/ffmpeg_mux.c fftools/ffmpeg_opt.c fftools/opt_common.c fftools/ffprobe.c \
    -o "$VG_VENDOR/ffmpeg-core.js" > "$VG_BUILD_ROOT/link.log" 2>&1
  cp config_components.h "$VG_VENDOR/source/config_components.h"
  python3 - "$VG_MANIFEST" "$VG_VENDOR" <<'PY'
import hashlib,json,sys
from pathlib import Path
path=Path(sys.argv[1]); vendor=Path(sys.argv[2]); manifest=json.loads(path.read_text())
manifest['sha256']={name:hashlib.sha256((vendor/name).read_bytes()).hexdigest()
                    for name in ['ffmpeg-core.js','ffmpeg-core.wasm']}
manifest['build']['protocols']=['file']
manifest['build']['configurationSha256']=hashlib.sha256((vendor/'source/config_components.h').read_bytes()).hexdigest()
path.write_text(json.dumps(manifest,indent=2)+'\n')
PY
fi

# Complete preferred-form FFmpeg and wrapper sources, local changes, licenses and build recipe.
VG_SOURCE_ROOT="$VG_BUILD_ROOT/ffmpeg-core-5.1.10-vg1-source"
mkdir -p "$VG_SOURCE_ROOT/vendor/ffmpeg-core" "$VG_SOURCE_ROOT/scripts" "$VG_SOURCE_ROOT/docs"
cp -R "$VG_BUILD_ROOT/archives" "$VG_SOURCE_ROOT/archives"
cp -R "$VG_VENDOR/source" "$VG_SOURCE_ROOT/vendor/ffmpeg-core/source"
cp -R "$VG_VENDOR/licenses" "$VG_SOURCE_ROOT/vendor/ffmpeg-core/licenses"
cp "$VG_MANIFEST" "$VG_SOURCE_ROOT/vendor/ffmpeg-core/manifest.json"
cp "$VG_REPO_ROOT/scripts/build-ffmpeg-core.sh" "$VG_SOURCE_ROOT/scripts/"
cp "$VG_REPO_ROOT/docs/FFMPEG_BUILD.md" "$VG_SOURCE_ROOT/docs/"
VG_SOURCE_ARCHIVE="$VG_REPO_ROOT/artifacts/release/ffmpeg-core-5.1.10-vg1-source.tar.gz"
tar -czf "$VG_SOURCE_ARCHIVE" -C "$VG_BUILD_ROOT" ffmpeg-core-5.1.10-vg1-source
python3 - "$VG_SOURCE_ARCHIVE" <<'PY'
import hashlib,sys
from pathlib import Path
p=Path(sys.argv[1]); p.with_name(p.name+'.sha256').write_text(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n')
PY
printf 'Source distribution: %s\n' "$VG_SOURCE_ARCHIVE"
if [ "$VG_MODE" = build ]; then printf 'Built %s\n' "$VG_VENDOR/ffmpeg-core.wasm"; fi
