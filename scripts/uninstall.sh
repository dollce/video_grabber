#!/bin/bash
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PACKAGE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
# shellcheck source=installation-common.sh
source "$SCRIPT_DIR/installation-common.sh"
target="$(vg_default_target)"
if [ -f "$PACKAGE_ROOT/.video-grabber-owned" ]; then target="$PACKAGE_ROOT"; fi
open_browser=1
browser_removed=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-open) open_browser=0; shift ;;
    --browser-removed) browser_removed=1; shift ;;
    --target-root) [ "$#" -ge 2 ] || vg_die '--target-root 값이 필요합니다.'; target="$2"; shift 2 ;;
    --help) printf '사용법: uninstall.command [--no-open] [--browser-removed] [--target-root /absolute/path/video-grabber]\n'; exit 0 ;;
    *) vg_die "알 수 없는 옵션: $1" ;;
  esac
done
cleanup() {
  local status=$?
  trap - EXIT
  set +e
  # vg_open_chrome disowns browser launchers; only mutation jobs remain here.
  wait || true
  vg_release_operation_lock
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
vg_acquire_operation_lock
vg_validate_target "$target"
target="$VG_TARGET"
vg_no_managed_descendants "$target"
vg_load_source_history "$target"
# A launcher run from its own checkout can also clean pre-installer build artifacts.
if vg_project_files "$PACKAGE_ROOT" && { [ -d "$PACKAGE_ROOT/.git" ] || [ -f "$PACKAGE_ROOT/.git" ] || vg_source_owned "$PACKAGE_ROOT"; }; then
  vg_no_symlink_ancestors "$PACKAGE_ROOT"
  if ! vg_has_source_root "$PACKAGE_ROOT"; then VG_DIRECT_SOURCE_ROOT="$PACKAGE_ROOT"; fi
  vg_add_source_root "$PACKAGE_ROOT" 0
fi
vg_validate_source_history
if [ "$browser_removed" -eq 0 ]; then
  extension="$target/extension"
  [ -d "$extension" ] || extension="$PACKAGE_ROOT/extension"
  [ -d "$extension" ] || extension="$PACKAGE_ROOT/dist"
  url="$(vg_uninstall_url "$extension")"
  vg_note '먼저 Chrome에서 Video Grabber를 제거해야 브라우저가 보관한 응답 데이터와 확장 설정도 정리됩니다.'
  [ "$open_browser" -eq 0 ] || vg_open_chrome "$url"
  vg_note "Chrome에서 열기: $url"
  [ -t 0 ] || vg_die 'Chrome에서 확장을 제거한 뒤 --browser-removed 옵션으로 다시 실행하세요. 아직 파일을 삭제하지 않았습니다.'
  printf 'Chrome의 제거 확인까지 마쳤다면 REMOVE를 입력하세요 (그 외 입력은 취소): '
  IFS= read -r confirmed
  [ "$confirmed" = REMOVE ] || vg_die '제거를 취소했습니다. 파일은 유지됩니다.'
fi
# Validate the complete set again after browser confirmation before deleting any
# root. An invalid later entry must never leave earlier checkouts half-cleaned.
vg_validate_source_history
vg_validate_target "$target"
vg_no_managed_descendants "$target"
while IFS= read -r source_root; do
  [ -n "$source_root" ] && [ -e "$source_root" ] || continue
  vg_source_artifacts "$source_root"
  vg_note "소스 빌드 의존성·캐시·로그·테스트 산출물 삭제: $source_root"
done <<< "$VG_SOURCE_ROOTS"
if [ -e "$target" ]; then
  # Recheck ownership immediately before the bounded recursive deletion.
  vg_validate_target "$target"
  rm -rf -- "$target"
  vg_note "설치 파일·캐시·로그 삭제: $target"
else vg_note '관리 설치 폴더가 이미 제거되어 있습니다.'
fi
vg_note '제거를 마쳤습니다. 소스 코드와 .git, 사용자가 저장한 영상, 다운로드한 원본 릴리스 ZIP은 유지됩니다.'
