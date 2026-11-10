# Video Grabber v1.0

현재 Chrome 탭에서 재생되는 미디어 요청을 감지하고, 영상과 오디오를 병합하거나 오디오만 저장하는 Manifest V3 확장 프로그램입니다. 실제 미디어 응답을 수집해 둔 뒤 재조립하는 기능도 제공합니다. 고정 버전으로 컴파일한 FFmpeg WebAssembly와 실행 의존성을 확장 프로그램에 함께 포함하므로, 별도 서버나 네이티브 FFmpeg 없이 동작합니다.

## 설치

실행 브라우저는 **Chrome 125 이상**을 사용합니다. [v1.0 릴리스](https://github.com/dollce/video_grabber/releases/tag/v1.0)에서 설치 ZIP을 받아 압축을 풉니다. 릴리스 ZIP으로 설치할 때는 **Node.js·npm·네이티브 FFmpeg가 필요하지 않습니다.**

1. macOS에서는 **`install.command`를 더블클릭**합니다. Linux에서는 압축을 푼 폴더에서 `bash scripts/install.sh`를 실행합니다.
2. 스크립트가 패키지 체크섬을 검증하고 사용자 전용 폴더에 확장을 준비한 뒤 Chrome 확장 관리 화면을 엽니다.
3. Chrome에서 **개발자 모드**를 켜고 **압축해제된 확장 프로그램을 로드합니다**를 누릅니다. 스크립트가 안내한 `extension` 폴더를 선택합니다.
4. 도구 모음에서 Video Grabber 아이콘을 고정합니다.

일반 Chrome의 보안 정책상 최종 확장 로드는 사용자가 확인해야 합니다. 스크립트는 설치 준비를 한 번에 실행하며, Chrome 정책이나 프로필 설정을 변경해 무인 설치를 강제하지 않습니다. macOS에서는 설치 경로를 클립보드에 복사하고 Finder에서도 폴더를 엽니다.

| 운영체제 | 기본 확장 설치 경로 |
| --- | --- |
| macOS | `~/Library/Application Support/Video Grabber/extension` |
| Linux | `~/.local/share/video-grabber/extension` |

업데이트는 새 릴리스의 설치 스크립트를 실행한 뒤 Chrome 확장 관리 화면의 새로고침 버튼을 누릅니다. 열려 있던 Video Grabber 관리 탭도 다시 열어 주세요. 상세 옵션과 경로 보호 방식은 [설치·제거 안내](docs/INSTALLATION.md)를 참고하세요.

### 제거

릴리스 또는 관리 설치 폴더의 **`uninstall.command`를 더블클릭**합니다. Linux에서는 `bash scripts/uninstall.sh`를 실행합니다. 스크립트가 여는 화면에서 Chrome의 확장 제거 확인을 완료하고, 터미널에 `REMOVE`를 입력하면 파일 정리를 마칩니다.

Chrome 제거는 수집 응답·확장 설정 등 브라우저가 관리하는 데이터를 정리합니다. 스크립트는 관리 설치 폴더 전체와 기록된 소스 빌드의 `node_modules`, `dist`, `artifacts`, `fixtures/media`, `.cache`, `.logs`를 삭제합니다. 소스 코드와 `.git`, 사용자가 저장한 영상, 원본 릴리스 ZIP은 보존하며, 시스템 도구나 다른 프로젝트의 의존성을 삭제하지 않습니다. Chrome에서 이미 제거했다면 `bash scripts/uninstall.sh --no-open --browser-removed`로 파일 정리만 실행할 수 있습니다.

### 소스에서 직접 빌드

소스 개발에는 **Node.js 22 이상**이 필요하며, 보안 패치가 적용된 LTS 버전(예: **22.23.4 이상**)을 권장합니다.

```sh
npm ci --ignore-scripts
npm run verify:vendor
npm run check
npm run security:check
```

`check`는 TypeScript 검사, 단위 테스트, 빌드를 순서대로 실행합니다. 빌드 결과인 `dist`를 Chrome에서 직접 로드하거나, 소스 폴더의 `install.command`로 관리 설치 경로에 준비할 수 있습니다. 빌드는 저장소에 포함된 FFmpeg 바이너리의 해시를 먼저 확인합니다. 코드를 변경한 뒤에는 다시 빌드하고 확장과 관리 탭을 새로고침하세요.

## 사용법

### 감지한 미디어 저장

1. 원하는 페이지에서 영상을 재생합니다. 설치 전에 열린 페이지라면 새로고침 후 재생하세요.
2. **해당 재생 탭에서** Video Grabber 아이콘을 누릅니다. 새 관리 탭이 열리며, 이후 다른 탭으로 이동해도 원래 재생 탭에 연결된 상태를 유지합니다.
3. 감지한 미디어에서 HLS, DASH 또는 일반 영상 파일을 선택합니다.
4. 파일 이름, 영상 화질, 오디오 트랙을 선택합니다. 영상과 오디오가 별도 파일로 감지되었다면 같은 영상에 해당하는 오디오를 직접 선택합니다.
5. **영상 + 오디오 저장** 또는 **오디오만 저장**을 누르고 저장 위치를 선택합니다.

병합·변환·저장이 끝날 때까지 관리 탭을 열어 두세요. 작업 중 **취소**로 다운로드와 변환을 중단할 수 있습니다. 영상 저장에는 실제 오디오 트랙이 필요하며, 오디오가 없는 미디어는 오류로 안내합니다.

### 재생 중인 응답 수집

일반 다운로드가 거부되는 주소나, 재생 후 오래된 조각이 사라지는 스트림에는 응답 수집을 사용할 수 있습니다.

1. 관리 탭에서 **응답 수집 시작**을 누릅니다.
2. 재생 페이지로 돌아가 새로고침하고 영상을 처음부터 재생합니다. 수집을 켜기 전에 전송된 데이터는 소급해 가져오지 못합니다.
3. 필요한 구간의 재생을 마치고 관리 탭에서 **응답 수집 중지**를 누릅니다.
4. 미디어와 트랙을 선택해 저장합니다. 다운로드 시 저장된 응답을 먼저 사용하고, 필요한 데이터가 없으면 원본 주소에 다시 요청합니다.

리다이렉트된 요청은 원래 주소와 최종 응답 주소를 함께 연결해 보관합니다. 저장할 때 원래 주소로 수집 데이터를 찾을 수 있으며, 재생 목록의 상대 경로는 최종 응답 주소를 기준으로 해석합니다.

수집 중에는 Chrome이 디버깅 연결 알림을 표시합니다. `debugger`는 설치 시 필요한 권한이지만 실제 연결은 **응답 수집 시작**을 누른 탭에서만 시작합니다. 다른 디버거와 연결이 충돌하거나 브라우저에서 연결을 해제하면 수집이 중단될 수 있습니다. 응답 수집 없이도 자동 감지와 일반 다운로드는 사용할 수 있습니다.

재생 페이지의 새로고침·페이지 이동은 이전 수집 데이터를 비우고 새 페이지를 기준으로 수집합니다. 수집 중지 후에는 새로고침하지 말고 먼저 저장하세요. **수집 내용 지우기**는 해당 탭의 감지 목록과 응답 데이터를 지웁니다.

## 지원 범위

| 입력 | 처리 범위 |
| --- | --- |
| 일반 미디어 | HTTP(S) 영상·오디오 파일. 원본에 포함된 오디오 추출 또는 사용자가 선택한 별도 오디오 파일과 병합 |
| HLS VOD | 마스터·미디어 재생 목록, 화질·오디오 선택, MPEG-TS 및 초기화 조각이 있는 fMP4, 바이트 범위, 불연속 구간 |
| HLS 라이브 | 수집한 재생 목록과 현재 목록에 남은 연속 구간. 시작 이전의 전체 방송이나 누락된 과거 구간은 보장하지 않음 |
| DASH VOD | 정적 MPD의 단일 Period, SegmentTemplate의 Number·Time·Timeline, SegmentList와 초기화·바이트 범위 |

**영상 출력은 MP4**를 우선 사용하며, 원본 영상 코덱과 MP4 조합을 처리하지 못하면 MKV로 다시 병합합니다. 영상은 재인코딩하지 않고 원본 코덱을 유지합니다. 오디오는 호환성을 위해 **AAC 192 kbps**로 인코딩합니다. **오디오 단독 출력은 M4A**입니다. 실제 코덱 처리 가능 여부는 포함된 FFmpeg 코어에 따릅니다.

다음은 현재 지원하지 않습니다.

- 동적 DASH, 여러 Period가 있는 DASH, SegmentBase 방식, 0이 아닌 DASH 시간 오프셋
- 같은 HLS 오디오 그룹에서 별도 URI 없이 영상 안에 함께 들어 있는 여러 오디오의 구분 선택. 해당 선택지는 제외하며, 같은 그룹에 별도 URI를 가진 오디오가 있으면 사용할 수 있음
- 조각 순서를 알 수 있는 재생 목록 없이 흩어진 미디어 조각을 임의로 연결하는 방식
- WebSocket·WebRTC 전송, 원본 HTTP(S) 파일이나 재생 목록을 찾을 수 없는 `blob:` 미디어
- 암호화된 HLS 및 보호된 미디어 처리. DRM은 이번 구현 범위에서 제외했습니다.

화질 변경으로 서로 다른 스트림이 섞이거나 수집 구간에 조각이 빠진 경우, 불완전한 파일을 성공으로 처리하지 않고 오류를 표시합니다. 사이트가 비표준 MIME이나 주소를 사용하면 자동 감지하지 못할 수 있습니다. 따라서 모든 사이트의 모든 영상 트래픽 수집을 보장하는 도구는 아닙니다.

## 용량과 인증 제한

| 항목 | 제한 |
| --- | --- |
| 응답 수집 | 탭당 256 MiB 또는 응답 10,000개 |
| 단일 수집 응답 | 32 MiB |
| 저장 작업의 원본 미디어 합계 | 512 MiB |
| 재생 목록 확장 | 최대 10,000개 조각 |

브라우저와 WebAssembly 메모리를 함께 사용하므로 실제 메모리 사용량은 원본 파일보다 큽니다. 한도보다 작은 파일이라도 사용 가능한 메모리가 부족하면 실패할 수 있습니다. 큰 파일은 현재 구현의 주 대상이 아닙니다.

원본 URL을 재요청할 때 브라우저가 허용하는 쿠키를 포함하지만, 페이지의 `Authorization`, 사용자 지정 인증 헤더, `Referer` 등을 복사해 재현하지는 않습니다. 만료된 서명 URL, 쿠키 정책, 사이트의 요청 검증에 따라 재요청이 실패할 수 있습니다. 이 경우 수집을 켜고 다시 재생하면 이미 수집된 응답을 사용할 수 있지만, 수집되지 않은 데이터까지 복구하지는 못합니다.

## 데이터와 권한

- 미디어 주소와 요청 메타데이터는 탭별로 관리하며, 응답 본문은 수집을 시작한 탭에 대해서만 IndexedDB에 보관합니다.
- 요청의 Cookie·Authorization 헤더는 저장하지 않습니다. 미디어 주소 자체에 포함된 쿼리 문자열은 원본 주소의 일부로 유지합니다.
- 수집 데이터는 로컬에서 처리합니다. 이 확장 프로그램 자체의 업로드 서버나 분석 수집 서버는 없습니다. 미디어가 부족하면 해당 사이트·CDN의 원본 주소에 다운로드 요청을 보냅니다.
- 재생 탭을 닫거나 브라우저를 다시 시작하면 수집 데이터를 정리합니다. 장기 보관용 녹화 저장소가 아니므로 필요한 파일은 먼저 다운로드하세요.

| 권한 | 용도 |
| --- | --- |
| `webRequest`, HTTP(S) 호스트 접근 | 페이지와 별도 CDN의 미디어 요청 감지 및 다운로드 |
| `debugger` | 사용자가 시작한 탭의 미디어 응답 본문 수집 |
| `tabs`, `activeTab` | 재생 탭 식별, 제목 표시 및 해당 탭으로 이동 |
| `storage`, `unlimitedStorage` | 탭 상태와 용량 제한 내 응답 데이터 저장 |
| `downloads` | 완성된 파일의 저장·취소·완료 확인 |

FFmpeg 코드와 WebAssembly는 빌드 결과에 포함되며 런타임에 CDN에서 실행 코드를 가져오지 않습니다.

## 고정 의존성과 보안 검증

이 릴리스는 **FFmpeg 5.1.10-vg1**을 최소 기능으로 컴파일한 전용 WebAssembly 코어를 사용합니다. 코어와 추가 보안 패치, 소스 식별 정보, SHA-256 해시는 `vendor/ffmpeg-core`에 포함합니다. 기존 npm 코어에 의존하지 않으며, 영상 디코더·네이티브 네트워크·외부 코덱 라이브러리를 제외하고 필요한 파일 처리와 오디오 변환 기능을 포함합니다. WASM 파일은 약 2.3 MiB이며 확장 패키지도 수 MiB 수준입니다.

JavaScript 의존성은 정확한 버전과 `package-lock.json`으로 고정합니다. `npm run verify:vendor`는 코어·소스·패치 해시를 검증하고, `npm run security:check`는 이 검증과 npm 보안 권고 검사를 실행합니다. npm 감사는 컴파일된 FFmpeg의 취약점 검토를 대신하지 않으므로, 네이티브 구성요소에 적용한 권고 검토와 패치 범위는 [SECURITY.md](SECURITY.md)에 별도로 기록합니다. 검증 결과는 알려지지 않은 취약점까지 없음을 보장하지 않습니다.

릴리스 패키지에는 파일 체크섬과 구성요소 정보가 포함됩니다. 배포 패키지를 생성하려면 보안 검사를 완료한 뒤 `npm run release:package`를 실행합니다. 검증 범위와 실제 실행 결과는 [VALIDATION.md](VALIDATION.md)를 참고하세요.

## 개발과 검증

```sh
npm run typecheck
npm test
npm run build
```

단위 테스트는 재생 목록 파싱, 미디어 판별, 바이트 범위 복원, 수집 상태 전환 등 실제 데이터 처리의 경계 조건을 검사합니다.

E2E 재생 데이터에는 H.264/AAC가 포함됩니다. 해당 코덱을 지원하고 확장 프로그램을 자동 로드할 수 있는 [공식 Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/)을 준비해 실행 파일 경로를 지정하세요. 일부 Playwright Chromium 빌드는 해당 코덱을 재생하지 못합니다.

```sh
CHROMIUM_PATH="/absolute/path/to/chrome-for-testing" FFMPEG="/absolute/path/to/ffmpeg" npm run test:e2e
```

로컬 미디어 fixture를 생성할 때는 **개발용 네이티브 FFmpeg**가 필요합니다. PATH에 없다면 `FFMPEG=/absolute/path/to/ffmpeg` 환경 변수로 실행 파일을 지정합니다. 이는 테스트 데이터 생성용이며 설치한 확장 프로그램의 실행에는 필요하지 않습니다. E2E는 fixture가 없으면 생성하고, 임의의 로컬 포트와 별도 Chromium 프로필로 확장 프로그램을 검증합니다. 실제 외부 서비스 전체에 대한 호환성 검증을 의미하지 않습니다.

`CHROMIUM_PATH`를 생략하면 Playwright Chromium을 사용합니다(`npx playwright install chromium`로 설치). Playwright 브라우저 저장 위치를 변경할 때는 표준 `PLAYWRIGHT_BROWSERS_PATH` 환경 변수를 사용할 수 있습니다.

수동으로 테스트 페이지를 열려면 다음을 실행한 뒤 [로컬 재생 페이지](http://127.0.0.1:8765)를 방문하세요. 이 서버는 개발 검증용이며 확장 프로그램의 일반 사용에는 필요하지 않습니다.

```sh
npm run fixtures
```

기본 포트는 `8765`이며 `PORT` 환경 변수로 바꿀 수 있습니다. 서버 실행 없이 미디어만 생성하려면 `npm run fixtures -- --generate-only`를 사용합니다.

주요 구성은 다음과 같습니다.

```text
public/                 Chrome manifest와 관리 화면 HTML
src/background.ts       탭별 요청 감지와 응답 수집
src/shared/             메시지 계약, 미디어 분류, 응답 저장소
src/media/              HLS·DASH 파싱, 데이터 취득, FFmpeg 병합
src/app.ts, src/app.css  한국어 관리 화면
tests/                  단위 테스트
scripts/                빌드와 로컬 검증 도구
vendor/ffmpeg-core/      고정 WASM 코어, 소스·패치, 해시와 라이선스
docs/INSTALLATION.md    설치·제거 동작과 정리 범위
dist/                   Chrome에 설치할 빌드 결과
```

번들에 포함된 구성요소에는 각각의 라이선스가 적용됩니다. 재배포 조건과 원본 출처, 함께 제공하는 소스·패치는 [THIRD_PARTY.md](THIRD_PARTY.md)를 확인하세요.

## 공식 문서

- [Chrome webRequest API](https://developer.chrome.com/docs/extensions/reference/api/webRequest)
- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome 확장 프로그램의 교차 출처 네트워크 요청](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [ffmpeg.wasm 사용법](https://ffmpegwasm.netlify.app/docs/getting-started/usage/)
