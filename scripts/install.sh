#!/bin/bash
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PACKAGE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
# shellcheck source=installation-common.sh
source "$SCRIPT_DIR/installation-common.sh"
target="$(vg_default_target)"
open_browser=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-open) open_browser=0; shift ;;
    --target-root) [ "$#" -ge 2 ] || vg_die '--target-root 값이 필요합니다.'; target="$2"; shift 2 ;;
    --help) printf '사용법: install.command [--no-open] [--target-root /absolute/path/video-grabber]\n'; exit 0 ;;
    *) vg_die "알 수 없는 옵션: $1" ;;
  esac
done
vg_validate_target "$target"
target="$VG_TARGET"
case "$PACKAGE_ROOT/" in "$target/"*) vg_die '설치 폴더 안의 파일에서 설치를 다시 실행할 수 없습니다. 원본 릴리스에서 실행하세요.' ;; esac
if vg_project_files "$PACKAGE_ROOT"; then
  # npm ci and the build replace source-owned artifact directories. Keep both
  # the existing installation and its staging directory outside that tree.
  case "$target/" in "$PACKAGE_ROOT/"*) vg_die '설치 경로는 소스 체크아웃 밖에 있어야 합니다. 빌드 중 기존 설치가 삭제될 수 있어 중단했습니다.' ;; esac
fi
[ ! -d "$PACKAGE_ROOT/extension" ] || [ -f "$PACKAGE_ROOT/SHA256SUMS" ] || vg_die '릴리스의 SHA256SUMS가 없습니다. 공식 릴리스 ZIP을 다시 받아 주세요.'
vg_verify_package "$PACKAGE_ROOT"
parent="${target%/*}"
mkdir -p -- "$parent"
vg_no_symlink_ancestors "$parent"
stage="$(mktemp -d "$parent/.video-grabber-stage.XXXXXX")"
backup=''
cleanup() {
  if [ -n "$stage" ] && [ -d "$stage" ]; then rm -rf -- "$stage"; fi
  if [ -n "$backup" ] && [ -d "$backup" ]; then
    if [ ! -e "$target" ] && [ -d "$backup/installation" ]; then mv -- "$backup/installation" "$target"; fi
    rm -rf -- "$backup"
  fi
}
trap cleanup EXIT
mkdir -p -- "$stage/logs" "$stage/cache" "$stage/scripts"
printf '%s\n' "$VG_INSTALL_MARKER" > "$stage/.video-grabber-owned"
printf '%s\n' 'Video Grabber installation started.' > "$stage/logs/install.log"

if [ -d "$PACKAGE_ROOT/extension" ]; then
  payload="$PACKAGE_ROOT/extension"
elif vg_project_files "$PACKAGE_ROOT"; then
  vg_note '소스에서 고정된 의존성으로 빌드합니다. 릴리스 ZIP은 이 단계가 필요하지 않습니다.'
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || vg_die '소스 빌드에는 Node.js 22 이상과 npm이 필요합니다. 도구 설치 없이 사용하려면 릴리스 ZIP을 받으세요.'
  node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || vg_die 'Node.js 22 이상이 필요합니다.'
  vg_mark_source "$PACKAGE_ROOT"
  printf '%s\n' "$PACKAGE_ROOT" > "$stage/source-root.txt"
  (cd -- "$PACKAGE_ROOT" && npm ci --ignore-scripts --cache "$stage/cache/npm" && npm run build) || vg_die '소스 빌드에 실패했습니다. 기존 설치는 유지됩니다.'
  payload="$PACKAGE_ROOT/dist"
else
  vg_die 'extension 폴더가 있는 릴리스 또는 Video Grabber 소스 폴더에서 실행해 주세요.'
fi
[ -d "$payload" ] && [ ! -L "$payload" ] || vg_die '확장 프로그램 빌드 폴더가 없습니다.'
[ -f "$payload/manifest.json" ] && grep -Eq '"name"[[:space:]]*:[[:space:]]*"Video Grabber"' "$payload/manifest.json" || vg_die 'Video Grabber manifest가 없습니다.'
[ -z "$(find "$payload" -type l -print -quit)" ] || vg_die '확장 프로그램 패키지에는 심볼릭 링크를 포함할 수 없습니다.'
cp -R -- "$payload" "$stage/extension"
cp -- "$SCRIPT_DIR/uninstall.sh" "$SCRIPT_DIR/installation-common.sh" "$stage/scripts/"
cp -- "$PACKAGE_ROOT/uninstall.command" "$stage/uninstall.command"
chmod 700 "$stage/uninstall.command" "$stage/scripts/uninstall.sh"
if [ ! -f "$stage/source-root.txt" ] && [ -f "$target/source-root.txt" ] && [ ! -L "$target/source-root.txt" ]; then
  cp -- "$target/source-root.txt" "$stage/source-root.txt"
fi
if [ -d "$target" ]; then
  backup="$(mktemp -d "$parent/.video-grabber-backup.XXXXXX")"
  mv -- "$target" "$backup/installation"
fi
mv -- "$stage" "$target"
stage=''
printf '%s\n' 'Package staging complete; Chrome user confirmation is still required.' >> "$target/logs/install.log"
if [ -n "$backup" ]; then rm -rf -- "$backup"; backup=''; fi
vg_note "확장 파일 준비 완료: $target/extension"
vg_note 'Chrome의 개발자 모드를 켠 뒤 [압축해제된 확장 프로그램을 로드합니다]에서 위 폴더를 선택하세요.'
vg_note '기존 설치를 업데이트했다면 Chrome 확장 관리 화면의 새로고침 버튼을 누르세요.'
vg_note "제거 실행 파일: $target/uninstall.command"
if [ "$open_browser" -eq 1 ]; then
  vg_open_chrome chrome://extensions
  if [ "$(uname -s)" = Darwin ]; then
    printf '%s' "$target/extension" | pbcopy
    open "$target/extension" >/dev/null 2>&1 || true
    vg_note '설치 폴더 경로를 클립보드에 복사했습니다.'
  fi
fi
