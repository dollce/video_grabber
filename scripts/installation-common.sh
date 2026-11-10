#!/bin/bash
# Shared filesystem guardrails. Never edits Chrome profiles or enterprise policies.
VG_INSTALL_MARKER='video-grabber-install-v1'
VG_SOURCE_MARKER='video-grabber-build-v1'
VG_SOURCE_ROOTS=''
VG_DIRECT_SOURCE_ROOT=''
VG_OPERATION_LOCK=''
VG_OPERATION_TOKEN=''

vg_die() { printf 'Video Grabber: %s\n' "$*" >&2; exit 1; }
vg_note() { printf '%s\n' "$*"; }

vg_acquire_operation_lock() {
  # One user-wide lock also serializes different targets that share source
  # checkouts. A mkdir lock needs no platform-specific locking utility.
  local root owner='' lock
  if [ -n "${VIDEO_GRABBER_LOCK_ROOT:-}" ]; then
    root="$VIDEO_GRABBER_LOCK_ROOT"
    vg_no_symlink_ancestors "$root"
    [ -d "$root" ] && [ -O "$root" ] || vg_die '검증용 잠금 경로는 현재 사용자가 소유한 기존 폴더여야 합니다.'
  else root="$(cd -- /tmp && pwd -P)"
  fi
  lock="$root/.video-grabber-operation-$UID.lock"
  vg_no_symlink_ancestors "$lock"
  if ! mkdir -m 700 -- "$lock" 2>/dev/null; then
    if [ -d "$lock" ] && [ ! -L "$lock" ] && [ -O "$lock" ] && [ -f "$lock/pid" ] && [ ! -L "$lock/pid" ]; then
      IFS= read -r owner < "$lock/pid" || owner=''
      if [[ ! "$owner" =~ ^[1-9][0-9]{0,9}$ ]]; then owner=''; fi
    fi
    [ -z "$owner" ] || vg_note "진행 중이거나 중단된 설치·제거 작업의 PID: $owner" >&2
    vg_die "다른 설치·제거 작업의 잠금이 있어 변경하지 않습니다: $lock"
  fi
  VG_OPERATION_LOCK="$lock"
  VG_OPERATION_TOKEN="$$:$RANDOM:$RANDOM"
  printf '%s\n' "$VG_OPERATION_TOKEN" > "$lock/token"
  printf '%s\n' "$$" > "$lock/pid"
}

vg_release_operation_lock() {
  local lock="$VG_OPERATION_LOCK"
  [ -n "$lock" ] || return 0
  if [ -d "$lock" ] && [ ! -L "$lock" ] && [ -O "$lock" ] &&
    [ -f "$lock/token" ] && [ ! -L "$lock/token" ] &&
    [ "$(cat "$lock/token")" = "$VG_OPERATION_TOKEN" ]; then
    # Never recursively remove a lock or erase another operation's metadata.
    rm -f -- "$lock/pid" "$lock/token"
    rmdir -- "$lock" || vg_note "잠금 폴더에 예상하지 못한 파일이 남았습니다: $lock" >&2
  else vg_note "잠금 소유 정보를 확인할 수 없어 보존했습니다: $lock" >&2
  fi
  VG_OPERATION_LOCK=''
}

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

vg_path_within() {
  # Compare existing directory identities, not spelling. This respects each
  # filesystem's case rules and still handles a child whose suffix is absent.
  local checked="${1%/}" ancestor="${2%/}"
  [ -n "$checked" ] || checked=/
  [ -n "$ancestor" ] || ancestor=/
  vg_absolute_path "$checked"
  vg_absolute_path "$ancestor"
  [ -d "$ancestor" ] || return 1
  while true; do
    [ ! "$checked" -ef "$ancestor" ] || return 0
    [ "$checked" != / ] || return 1
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
  [ "$VG_TARGET" != "$HOME" ] && [ ! "$VG_TARGET" -ef "$HOME" ] || vg_die '사용자 홈 폴더를 설치 폴더로 사용할 수 없습니다.'
  vg_no_symlink_ancestors "$VG_TARGET"
  if [ -e "$VG_TARGET" ]; then
    [ -d "$VG_TARGET" ] || vg_die '설치 경로가 폴더가 아닙니다.'
    [ -f "$VG_TARGET/.video-grabber-owned" ] && [ ! -L "$VG_TARGET/.video-grabber-owned" ] || vg_die '기존 폴더에 Video Grabber 소유 표시가 없어 변경하지 않습니다.'
    [ "$(cat "$VG_TARGET/.video-grabber-owned")" = "$VG_INSTALL_MARKER" ] || vg_die '기존 폴더의 소유 표시가 올바르지 않아 변경하지 않습니다.'
  fi
}

vg_no_managed_descendants() {
  local path="$1" nested
  [ -d "$path" ] || return 0
  nested="$(find "$path" -mindepth 2 -name .video-grabber-owned -print -quit)" || vg_die '하위 설치 경로를 확인할 수 없어 변경하지 않습니다.'
  [ -z "$nested" ] || vg_die '다른 관리 설치 폴더를 포함하는 경로는 변경하지 않습니다. 안쪽 설치를 먼저 제거하세요.'
}

vg_no_managed_ancestors() {
  local path="${1%/*}"
  while [ -n "$path" ] && [ "$path" != / ]; do
    [ ! -e "$path/.video-grabber-owned" ] && [ ! -L "$path/.video-grabber-owned" ] || vg_die '다른 관리 설치 폴더 안에는 설치할 수 없습니다.'
    [ ! -e "$path/.video-grabber-build-root" ] && [ ! -L "$path/.video-grabber-build-root" ] || vg_die '설치 경로는 소유 표시가 있는 소스 체크아웃 밖에 있어야 합니다.'
    path="${path%/*}"
  done
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

vg_validate_source_artifacts() {
  local path="$1" item
  vg_no_symlink_ancestors "$path/.video-grabber-build-root"
  for item in node_modules dist artifacts fixtures/media .cache .logs; do
    vg_no_symlink_ancestors "$path/$item"
    [ ! -e "$path/$item/.video-grabber-owned" ] && [ ! -L "$path/$item/.video-grabber-owned" ] || vg_die '소스 삭제 대상에 관리 설치가 있어 정리를 중단했습니다. 안쪽 설치를 먼저 제거하세요.'
    vg_no_managed_descendants "$path/$item"
  done
}

vg_source_cleaned() {
  # Another installation may already have removed this shared checkout's build
  # output. Missing ownership is safe only when there is nothing left to erase.
  local path="$1" item
  vg_project_files "$path" || return 1
  vg_validate_source_artifacts "$path"
  [ ! -e "$path/.video-grabber-build-root" ] && [ ! -L "$path/.video-grabber-build-root" ] || return 1
  for item in node_modules dist artifacts fixtures/media .cache .logs; do
    [ ! -e "$path/$item" ] && [ ! -L "$path/$item" ] || return 1
  done
}

vg_source_ready() {
  vg_source_owned "$1" || vg_source_cleaned "$1"
}

vg_has_source_root() {
  local candidate
  while IFS= read -r candidate; do
    [ "$candidate" != "$1" ] || return 0
  done <<< "$VG_SOURCE_ROOTS"
  return 1
}

vg_add_source_root() {
  local path="$1" require_owned="${2:-1}"
  # Check even missing entries: a dangling symlink or malformed path must not
  # be silently discarded as an absent checkout.
  vg_no_symlink_ancestors "$path"
  [ -e "$path" ] || return 0
  if [ "$require_owned" -eq 1 ]; then
    vg_source_ready "$path" || vg_die '기록된 소스 폴더의 소유 표시가 일치하지 않아 변경하지 않습니다.'
  else vg_project_files "$path" || vg_die '확인된 Video Grabber 소스 폴더가 아닙니다.'
  fi
  vg_validate_source_artifacts "$path"
  vg_has_source_root "$path" && return 0
  VG_SOURCE_ROOTS="${VG_SOURCE_ROOTS}${VG_SOURCE_ROOTS:+$'\n'}$path"
}

vg_load_source_history() {
  local root="$1" metadata recorded
  for metadata in "$root/source-root.txt" "$root/source-roots.txt"; do
    if [ ! -e "$metadata" ] && [ ! -L "$metadata" ]; then continue; fi
    [ -f "$metadata" ] && [ ! -L "$metadata" ] || vg_die '소스 경로 기록은 일반 파일이어야 합니다.'
    [ -s "$metadata" ] || vg_die '소스 경로 기록이 비어 있어 변경하지 않습니다.'
    if [ "${metadata##*/}" = source-root.txt ]; then
      # Legacy metadata is exactly one path; embedded newlines are invalid.
      recorded="$(cat "$metadata")"
      vg_add_source_root "$recorded"
    else
      while IFS= read -r recorded || [ -n "$recorded" ]; do
        [ -n "$recorded" ] || vg_die '소스 경로 기록에 빈 항목이 있습니다.'
        vg_add_source_root "$recorded"
      done < "$metadata"
    fi
  done
}

vg_validate_source_history() {
  local path other item
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    vg_no_symlink_ancestors "$path"
    [ -e "$path" ] || continue
    if [ "$path" = "$VG_DIRECT_SOURCE_ROOT" ]; then
      vg_project_files "$path" || vg_die '실행 중인 소스 폴더가 변경되어 정리를 중단했습니다.'
    else vg_source_ready "$path" || vg_die '기록된 소스 폴더의 소유 표시가 일치하지 않아 변경하지 않습니다.'
    fi
    vg_validate_source_artifacts "$path"
    while IFS= read -r other; do
      [ -n "$other" ] || continue
      for item in node_modules dist artifacts fixtures/media .cache .logs; do
        if vg_path_within "$other" "$path/$item"; then
          vg_die '기록된 소스 폴더가 다른 소스의 삭제 대상 안에 있어 정리를 중단했습니다.'
        fi
      done
    done <<< "$VG_SOURCE_ROOTS"
  done <<< "$VG_SOURCE_ROOTS"
}

vg_write_source_history() {
  local root="$1" pending
  [ -n "$VG_SOURCE_ROOTS" ] || return 0
  pending="$(mktemp "$root/.source-roots.XXXXXX")" || vg_die '소스 경로 기록을 준비할 수 없습니다.'
  if ! printf '%s\n' "$VG_SOURCE_ROOTS" > "$pending" || ! mv -- "$pending" "$root/source-roots.txt"; then
    rm -f -- "$pending"
    vg_die '소스 경로 기록을 저장할 수 없어 빌드를 중단했습니다.'
  fi
}

vg_source_artifacts() {
  local path="$1" item
  vg_validate_source_artifacts "$path"
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
  local url="$1" browser=''
  case "$(uname -s)" in
    Darwin) open -a 'Google Chrome' "$url" >/dev/null 2>&1 || vg_note "Chrome에서 직접 열어 주세요: $url" ;;
    Linux)
      if command -v google-chrome >/dev/null 2>&1; then browser=google-chrome
      elif command -v chromium >/dev/null 2>&1; then browser=chromium
      else vg_note "Chrome에서 직접 열어 주세요: $url"
      fi
      if [ -n "$browser" ]; then
        # A cold browser can outlive this installer. It must neither consume
        # the removal prompt's input nor remain among cleanup's mutation jobs.
        "$browser" "$url" </dev/null >/dev/null 2>&1 &
        disown "$!" 2>/dev/null || true
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
