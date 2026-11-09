#!/bin/bash
# Shared filesystem guardrails. Never edits Chrome profiles or enterprise policies.
VG_INSTALL_MARKER='video-grabber-install-v1'
VG_SOURCE_MARKER='video-grabber-build-v1'

vg_die() { printf 'Video Grabber: %s\n' "$*" >&2; exit 1; }
vg_note() { printf '%s\n' "$*"; }

vg_default_target() {
  case "$(uname -s)" in
    Darwin) printf '%s/Library/Application Support/Video Grabber\n' "$HOME" ;;
    Linux) printf '%s/.local/share/video-grabber\n' "$HOME" ;;
    *) vg_die '지원하는 설치 운영체제는 macOS와 Linux입니다.' ;;
  esac
}

vg_absolute_path() {
  case "$1" in
    /*) ;;
    *) vg_die "절대 경로가 필요합니다: $1" ;;
  esac
  case "$1" in
    *$'\n'*|*$'\r'*|*'//'*|*/../*|*/./*|*/..|*/.) vg_die '줄바꿈, 중복 구분자 또는 상대 경로 요소가 있는 경로는 사용할 수 없습니다.' ;;
  esac
}

vg_no_symlink_ancestors() {
  local checked="$1"
  vg_absolute_path "$checked"
  while [ "$checked" != / ]; do
    [ ! -L "$checked" ] || vg_die "심볼릭 링크 경로는 변경하지 않습니다: $checked"
    checked="${checked%/*}"
    [ -n "$checked" ] || checked=/
  done
}

vg_validate_target() {
  VG_TARGET="${1%/}"
  vg_absolute_path "$VG_TARGET"
  case "${VG_TARGET##*/}" in
    'Video Grabber'|video-grabber) ;;
    *) vg_die '설치 경로의 마지막 폴더 이름은 Video Grabber 또는 video-grabber여야 합니다.' ;;
  esac
  local parent="${VG_TARGET%/*}"
  [ -n "$parent" ] && [ "$parent" != / ] && [ "${parent%/*}" != '' ] || vg_die '파일시스템 최상위에는 설치하거나 삭제할 수 없습니다.'
  [ "$VG_TARGET" != "$HOME" ] || vg_die '사용자 홈 폴더를 설치 폴더로 사용할 수 없습니다.'
  vg_no_symlink_ancestors "$VG_TARGET"
  if [ -e "$VG_TARGET" ]; then
    [ -d "$VG_TARGET" ] || vg_die '설치 경로가 폴더가 아닙니다.'
    [ -f "$VG_TARGET/.video-grabber-owned" ] && [ ! -L "$VG_TARGET/.video-grabber-owned" ] || vg_die '기존 폴더에 Video Grabber 소유 표시가 없어 변경하지 않습니다.'
    [ "$(cat "$VG_TARGET/.video-grabber-owned")" = "$VG_INSTALL_MARKER" ] || vg_die '기존 폴더의 소유 표시가 올바르지 않아 변경하지 않습니다.'
  fi
}

vg_project_files() {
  local path="$1"
  [ -f "$path/package.json" ] && [ ! -L "$path/package.json" ] &&
    [ -f "$path/package-lock.json" ] && [ ! -L "$path/package-lock.json" ] &&
    [ -f "$path/src/background.ts" ] && [ -f "$path/public/manifest.json" ] &&
    grep -Eq '"name"[[:space:]]*:[[:space:]]*"video-grabber"' "$path/package.json"
}

vg_mark_source() {
  local path="$1"
  vg_no_symlink_ancestors "$path"
  vg_project_files "$path" || vg_die '확인된 Video Grabber 소스 폴더가 아닙니다.'
  [ ! -L "$path/.video-grabber-build-root" ] || vg_die '소스 소유 표시가 심볼릭 링크입니다.'
  printf '%s\n%s\n' "$VG_SOURCE_MARKER" "$path" > "$path/.video-grabber-build-root"
}

vg_source_owned() {
  local path="$1"
  vg_absolute_path "$path"
  vg_no_symlink_ancestors "$path"
  vg_project_files "$path" || return 1
  [ -f "$path/.video-grabber-build-root" ] && [ ! -L "$path/.video-grabber-build-root" ] || return 1
  [ "$(cat "$path/.video-grabber-build-root")" = "$(printf '%s\n%s' "$VG_SOURCE_MARKER" "$path")" ]
}

vg_source_artifacts() {
  # First validate every deletion target. A bad entry prevents partial cleanup.
  local path="$1" item
  for item in node_modules dist artifacts fixtures/media .cache .logs; do
    vg_no_symlink_ancestors "$path/$item"
  done
  for item in node_modules dist artifacts fixtures/media .cache .logs; do
    [ ! -e "$path/$item" ] || rm -rf -- "$path/$item"
  done
  rm -f -- "$path/.video-grabber-build-root"
}

vg_verify_package() {
  local root="$1" checksum line relative candidate listed found
  [ -f "$root/SHA256SUMS" ] || return 0
  [ ! -L "$root/SHA256SUMS" ] || vg_die '체크섬 목록은 심볼릭 링크일 수 없습니다.'
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    checksum="${line%% *}"
    relative="${line#*  }"
    [[ "$checksum" =~ ^[0-9a-fA-F]{64}$ ]] || vg_die '체크섬 목록 형식이 올바르지 않습니다.'
    [ "$relative" != "$line" ] && [ -n "$relative" ] || vg_die '체크섬 파일 경로가 없습니다.'
    case "$relative" in /*|../*|*/../*|*/..|./*|*/./*|*'//'*) vg_die '패키지 밖을 가리키는 체크섬 경로입니다.' ;; esac
    vg_no_symlink_ancestors "$root/$relative"
    [ -f "$root/$relative" ] || vg_die "패키지 파일이 없습니다: $relative"
  done < "$root/SHA256SUMS"
  if [ -d "$root/extension" ]; then
    while IFS= read -r candidate; do
      relative="${candidate#"$root/"}"
      found=0
      while IFS= read -r listed || [ -n "$listed" ]; do
        if [ "${listed#*  }" = "$relative" ]; then found=1; break; fi
      done < "$root/SHA256SUMS"
      [ "$found" -eq 1 ] || vg_die "체크섬 목록에 없는 확장 파일입니다: $relative"
    done < <(find "$root/extension" -type f)
  fi
  if command -v shasum >/dev/null 2>&1; then
    (cd -- "$root" && shasum -a 256 -c SHA256SUMS >/dev/null) || vg_die '패키지 체크섬이 일치하지 않습니다. 릴리스 파일을 다시 받아 주세요.'
  elif command -v sha256sum >/dev/null 2>&1; then
    (cd -- "$root" && sha256sum -c SHA256SUMS >/dev/null) || vg_die '패키지 체크섬이 일치하지 않습니다. 릴리스 파일을 다시 받아 주세요.'
  else vg_die '체크섬 검증에 필요한 shasum 또는 sha256sum이 없습니다.'
  fi
}

vg_open_chrome() {
  local url="$1"
  case "$(uname -s)" in
    Darwin) open -a 'Google Chrome' "$url" >/dev/null 2>&1 || vg_note "Chrome에서 직접 열어 주세요: $url" ;;
    Linux)
      if command -v google-chrome >/dev/null 2>&1; then google-chrome "$url" >/dev/null 2>&1 &
      elif command -v chromium >/dev/null 2>&1; then chromium "$url" >/dev/null 2>&1 &
      else vg_note "Chrome에서 직접 열어 주세요: $url"
      fi ;;
  esac
}

vg_uninstall_url() {
  local extension="$1" identifier
  if [ -f "$extension/extension-id.txt" ] && [ ! -L "$extension/extension-id.txt" ]; then
    identifier="$(cat "$extension/extension-id.txt")"
    if [[ "$identifier" =~ ^[a-p]{32}$ ]] && [ -f "$extension/uninstall.html" ]; then
      printf 'chrome-extension://%s/uninstall.html\n' "$identifier"
      return
    fi
  fi
  printf 'chrome://extensions\n'
}
