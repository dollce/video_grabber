# 설치와 완전 제거

macOS에서 릴리스 ZIP의 압축을 풀고 `install.command`를 더블클릭하면 고정 버전 확장 파일을 사용자 전용 설치 폴더에 준비하고 Chrome 확장 관리 화면을 엽니다. 릴리스에는 실행 의존성이 포함되므로 Node.js·npm·네이티브 FFmpeg를 별도로 설치하지 않습니다. Linux에서는 `bash scripts/install.sh`를 실행합니다.

일반 macOS Chrome은 웹 스토어 밖의 확장을 스크립트로 무인 설치할 수 없습니다. 설치 창을 여는 동작은 한 번에 실행되지만, **Chrome에서 개발자 모드를 켜고 ‘압축해제된 확장 프로그램을 로드합니다’를 눌러 폴더를 선택하는 사용자 동작은 필요합니다.** 이 스크립트는 Chrome 정책이나 프로필 설정을 변경하지 않습니다. [Chrome 설치 정책](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions), [unpacked 설치 방법](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)

## 설치 위치

- macOS: `~/Library/Application Support/Video Grabber/extension`
- Linux: `~/.local/share/video-grabber/extension`

macOS 설치 스크립트는 위 경로를 클립보드에 복사하고 Finder에서도 폴더를 엽니다. 관리 폴더 안에는 확장 파일, 제거 스크립트, 해당 설치의 캐시와 간단한 설치 로그만 보관합니다. `SHA256SUMS`가 포함된 릴리스는 설치 전에 파일 해시를 검사합니다. 기존 설치가 있으면 준비 완료 후 교체하며, Chrome의 확장 새로고침 버튼으로 업데이트를 적용합니다.

소스 저장소에서 실행하면 `npm ci --ignore-scripts`와 `npm run build`를 실행합니다. 이 경로에만 Node.js 22 이상과 npm이 필요합니다. 설치 스크립트가 전역 도구를 설치하지는 않습니다. npm 캐시는 관리 설치 폴더에 두고, 생성한 소스 의존성·빌드 산출물의 위치를 기록합니다.

## 제거

릴리스나 관리 설치 폴더의 `uninstall.command`를 더블클릭합니다. Linux에서는 `bash scripts/uninstall.sh`를 실행합니다.

1. 스크립트가 여는 제거 화면에서 **Chrome의 확장 제거 확인**까지 완료합니다. 지원되는 패키지는 전용 제거 화면으로 이동하며, 그렇지 않으면 `chrome://extensions`에서 Video Grabber를 제거합니다. 이 단계가 브라우저가 관리하는 IndexedDB 응답 데이터와 확장 설정을 정리합니다.
2. 터미널에 `REMOVE`를 입력하면 아래 로컬 산출물을 삭제합니다. 취소하거나 표준 입력이 없는 환경에서는 파일을 먼저 삭제하지 않습니다.

삭제 대상:

- 관리 설치 폴더 전체: 확장, 로컬 의존성, 제거 스크립트, 캐시, 로그
- 설치 스크립트가 기록한 소스 폴더의 `node_modules`, `dist`, `artifacts`, `fixtures/media`, `.cache`, `.logs`
- 자신의 소스 저장소에서 실행한 제거 스크립트는 같은 목록의 이전 빌드 산출물도 정리
- 소스 폴더의 생성된 소유 표시 `.video-grabber-build-root`

소스 코드·`.git`·사용자가 저장한 영상 파일·다운로드한 원본 ZIP은 보존합니다. 시스템 Node.js, Chrome, 공유 npm 캐시 또는 다른 프로젝트의 의존성도 삭제하지 않습니다. 이 프로그램이 설치한 전역 의존성은 없습니다. 다운로드한 ZIP/압축을 푼 원본 배포 폴더 자체도 없애려면 Finder에서 해당 다운로드 항목을 삭제하세요.

소유 표시가 없거나 다른 폴더, 심볼릭 링크를 경유하는 삭제 경로는 거부합니다. 제거를 반복 실행해도 이미 제거된 관리 폴더로 인해 실패하지 않습니다.

## 자동 검증 및 직접 지정

브라우저를 열지 않고 파일 준비만 하려면 `--no-open`을 사용합니다. 설치 완료를 뜻하지는 않습니다.

```sh
bash scripts/install.sh --no-open
```

브라우저에서 이미 제거했다면 다음과 같이 파일 정리만 실행할 수 있습니다. **`--browser-removed`는 Chrome 데이터가 제거됐다는 실행자의 명시적 확인이며, 브라우저 제거를 대신하지 않습니다.**

```sh
bash scripts/uninstall.sh --no-open --browser-removed
```

테스트나 별도 관리 폴더에는 `--target-root /absolute/path/video-grabber`를 사용할 수 있습니다. 경로의 마지막 폴더 이름은 `video-grabber` 또는 `Video Grabber`여야 하며, 기존 폴더에는 일치하는 소유 표시가 있어야 합니다. 소스에서 설치할 때는 빌드가 기존 설치를 지우지 않도록 **소스 체크아웃 밖의 경로**만 허용합니다. 자동 테스트는 임시 디렉터리에서만 설치와 제거를 실행합니다.
