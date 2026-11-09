# Media dependency review — 2026-11-10

This review covers the fixed media dependencies shipped for v1.0. It records known-advisory triage against the actual FFmpeg source and component selection. It does **not** certify absence of vulnerabilities or provide an exhaustive audit of FFmpeg, Emscripten, Chrome, or every transitive dependency.

## Version and provenance evidence

| Component | Pinned input | Evidence |
| --- | --- | --- |
| Custom media core | `5.1.10-vg1` | [Local provenance manifest](../vendor/ffmpeg-core/manifest.json), including binary, archive and patch SHA-256 values |
| FFmpeg | `n5.1.10`, commit `19feb712f5c1821d8a3fa1ad63c5bd2e3b9672eb` | [Official release list](https://ffmpeg.org/download.html#release_5.1), [source tag](https://github.com/FFmpeg/FFmpeg/tree/n5.1.10). Release date: 2026-06-21. This is the 5.1 maintenance line, not the newest FFmpeg major version. |
| FFmpeg source archive | SHA-256 `bbb08946e1a4dcba2f0962c7bb79bc3fc900dbc3251c044aab9bbf81b93c47a1` | [Pinned GitHub source archive](https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/19feb712f5c1821d8a3fa1ad63c5bd2e3b9672eb); this digest is for this archive, not the differently packaged ffmpeg.org tarball |
| WASM CLI integration source | ffmpeg.wasm commit `f876f907c7e9b9bf51d4ed0b913a855a63ae63fc` | [Pinned source](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/f876f907c7e9b9bf51d4ed0b913a855a63ae63fc), [local adaptation](../vendor/ffmpeg-core/source/patches/wasm-wrapper.patch) |
| Build toolchain | Emscripten `3.1.40`; emsdk commit `ae245715ef50e036b68a2412a323129676bf8300` | [Pinned SDK source](https://github.com/emscripten-core/emsdk/tree/ae245715ef50e036b68a2412a323129676bf8300); build-only compatibility choice, not a claim that this is the latest toolchain |
| Runtime API wrapper | `@ffmpeg/ffmpeg 0.12.15` | [package.json](../package.json), [package-lock.json](../package-lock.json), [upstream releases](https://github.com/ffmpegwasm/ffmpeg.wasm/releases) |
| XML parser | `fast-xml-parser 5.12.0` | Exact direct version and transitive package integrity are recorded in the same lockfile. |

The previously considered npm package `@ffmpeg/core 0.12.10` embedded FFmpeg 5.1.4. The [upstream build configuration](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/f876f907c7e9b9bf51d4ed0b913a855a63ae63fc/Dockerfile) pins that older FFmpeg line and many external media libraries. The shipped custom core replaces that binary and omits external codec libraries; the npm wrapper's version is not the native FFmpeg version.

The review checked the official release listing, source revisions and public upstream fixes. It also used the [Debian FFmpeg tracker](https://security-tracker.debian.org/tracker/source-package/ffmpeg) as an advisory index. The tracker listed 56 open/open-unimportant entries at review time; its bookworm package was 5.1.9, not this 5.1.10 build. Its generic version classifications therefore were not accepted as proof of applicability. A sample of resolved newer issues was also checked, but this is not an assertion that every historical advisory was independently reassessed.

## Actual build and input boundary

The build starts from `--disable-everything --disable-autodetect --disable-network` and enables selected components. See the [build recipe](../scripts/build-ffmpeg-core.sh), [component configuration](../vendor/ffmpeg-core/source/config_components.h) and [provenance manifest](../vendor/ffmpeg-core/manifest.json).

| Category | Included scope |
| --- | --- |
| Demuxers | MOV/MP4, Matroska/WebM, MPEG-TS, HLS, AAC, MP3, FLAC, Ogg, WAV, AC-3/E-AC-3 |
| Muxers | MP4, iPod/M4A, MOV dependency, Matroska |
| Audio decoders | AAC/LATM, AC-3/E-AC-3, MP2/MP3 integer/float, Opus, Vorbis, FLAC, selected PCM variants |
| Encoder | AAC only |
| Video handling | Stream copy; H264, HEVC, AV1, VP8/9 and MPEG video parsers remain enabled, but video/image decoders are excluded |
| Bitstream filters | AAC ADTS-to-ASC, extradata extraction, H264/HEVC Annex B conversion, VP9 superframe; Matroska also selects PGS frame merge |
| Processing filters | Audio format/resampling/trim/null and basic format/trim/null infrastructure; no optional effect filters |
| Protocols | `file` only; no `data`, HTTP(S), TLS, RTSP, SFTP, RIST or legacy `hls` protocol |
| Other | No external codec libraries, hardware acceleration, pthreads or native networking |

The TypeScript layer parses original HLS/MPD documents, fetches selected HTTP(S) resources, and writes bounded data into the WASM memory filesystem. Native HLS receives newly generated local playlists with generated names and validated durations, not original remote tags or URLs. DASH uses the application parser and prepared media files; FFmpeg's DASH demuxer is absent. Raw container and audio payloads remain untrusted. A small component list reduces exposed parsing code but does not make these payloads safe by definition. See [manifest parsing](../src/media/manifests.ts), [fetch limits](../src/media/fetcher.ts) and [media execution](../src/media/engine.ts).

A project [parser and HLS metadata adaptation](../vendor/ffmpeg-core/source/patches/parser-remux-dimensions.patch) lets MPEG-TS probing obtain H264/HEVC dimensions without enabling either decoder. Its parser change fills missing codec-context dimensions from the existing SPS parser only when no decoder is available, checks positive display dimensions with `av_image_check_size`, and accepts only a recognized pixel-format descriptor. That parser step preserves existing container dimensions. The upstream [H264 SPS parser](https://github.com/FFmpeg/FFmpeg/blob/n5.1.10/libavcodec/h264_ps.c) and [HEVC SPS parser](https://github.com/FFmpeg/FFmpeg/blob/n5.1.10/libavcodec/hevc_ps.c) already validate coded dimensions before this metadata is produced. The HLS change then forwards positive width/height and pixel format from the sub-demuxer's codec context when the parent width is missing, the H264/HEVC codec IDs match, and no decoder is available. It marks the parent context for refresh; it does not copy input-controlled pointers or enable another codec. This is a local compatibility patch, not an upstream security fix; it does not change the decoder exclusions in the matrix below.

## Applicable patches and source comparisons

- **CVE-2026-107678:** 5.1.10 still recursively freed `AVEncryptionInitInfo` chains. The first patch from [upstream PR 24593](https://code.ffmpeg.org/FFmpeg/FFmpeg/pulls/24593) changes this to iteration. The upstream PR also discusses quadratic MOV PSSH accumulation. Rather than claim the first patch fixes that separate cost, this build additionally rejects `pssh` before constructing its list, consistent with the excluded protected-media scope. [Free-list patch](../vendor/ffmpeg-core/source/patches/CVE-2026-107678.patch), [PSSH restriction](../vendor/ffmpeg-core/source/patches/disable-pssh.patch).
- **CVE-2026-107695 / CVE-2026-107697:** backported the [media/master tag validation](https://github.com/FFmpeg/FFmpeg/commit/c364ab176f722bdabc886845e770c9eacbc1e3e5) and [child-playlist protocol check](https://github.com/FFmpeg/FFmpeg/commit/23602df9cd1b485c45ba6f533d3b85569de3f323). These strengthen native handling even though the application generates its own playlists. [Local patches](../vendor/ffmpeg-core/source/patches).
- **CVE-2026-75141:** incorporated the [upstream 16-bit hvcC count bound](https://github.com/FFmpeg/FFmpeg/commit/acf5d7cdc1f9ae8752c23e1ea8d7f355ed780781) into the older structure. The 5.1.10 code writes using the saved pre-increment count, unlike the newer vulnerable code, so the reported heap-overflow behavior was not established for this base. The bound prevents count wrap regardless. [Adapted guard](../vendor/ffmpeg-core/source/patches/hevc-count-bound.patch).
- **CVE-2023-6601:** its `data:` URI route is excluded by compiling only the `file` protocol and using a file-only input whitelist. This is a build/input restriction, not a claim that the historical HLS source fix was backported.
- **CVE-2026-107676 / CVE-2026-13858:** source inspection found the relevant HDR serializer absent from 5.1.10 and the older MOV seek loop already rejecting negative `sample` before the key-sample helper. The newer `requested_sample` path patched for Chrome is absent. Compare [old HDR source](https://github.com/FFmpeg/FFmpeg/blob/n5.1.10/libavutil/hdr_dynamic_metadata.c), [old MOV source](https://github.com/FFmpeg/FFmpeg/blob/n5.1.10/libavformat/mov.c), [newer MOV fix](https://github.com/FFmpeg/FFmpeg/commit/256d93413f260e1524c2ab994dc72c4edaa0d04c).
- **CVE-2026-30999:** the [upstream fix](https://github.com/FFmpeg/FFmpeg/commit/144af8f81abc1385631b4e1f4672cd415a9c6e05) identifies a memory leak in `tools/zmqsend`, not an `av_bprint_finalize` heap overflow. The tool is not shipped. The 5.1.10 source also includes [its backport](https://github.com/FFmpeg/FFmpeg/commit/946bf8977e64c38811c7deaf69d9d09b3168971f).

Resolved-version cross-checks: [CVE-2026-52295](https://security-tracker.debian.org/tracker/CVE-2026-52295) and [CVE-2026-52297](https://security-tracker.debian.org/tracker/CVE-2026-52297) concern newer IAMF code; [CVE-2026-96611](https://security-tracker.debian.org/tracker/CVE-2026-96611) concerns newer HEIF grid code; [CVE-2026-75145](https://security-tracker.debian.org/tracker/CVE-2026-75145) and [CVE-2026-75147](https://security-tracker.debian.org/tracker/CVE-2026-75147) concern AV1 RTP support introduced after 5.1. These paths are absent from this base/build.

## Automated evidence and limits

- `npm audit --json --ignore-scripts` on 2026-11-10 reported **0** advisories for the locked dependency graph, including development dependencies. The release gate reruns the query and saves its result under `artifacts/security/npm-audit.json`.
- An [OSV commit query](https://google.github.io/osv.dev/post-v1-query/) for exact FFmpeg commit `19feb712f5c1821d8a3fa1ad63c5bd2e3b9672eb` returned `{}`. This was **not** accepted as proof of no vulnerabilities: the source comparison above found an applicable issue. Coverage and version mapping differ between databases.
- `npm run verify:vendor` verifies embedded binary SHA-256 and exact direct dependency versions against the lockfile. This is integrity verification, not vulnerability discovery. Archive/patch digests and build provenance are independently recorded in the vendor manifest.
- Compile configuration and source comparisons support the classifications below. They are not executions of all CVE proofs of concept. Functional merge tests do not constitute a security fuzzing campaign. The release's test results are recorded separately by the release workflow.
- FFmpeg parser/decoder bugs not in these sources, decompression/resource amplification, the Emscripten runtime, and browser vulnerabilities remain possible. The selected older toolchain supports this wrapper and is pinned for rebuilding; a comprehensive toolchain security audit was not performed. The application has source-size, manifest, timeout and cancellation limits, but memory use can exceed source size and limits do not eliminate every denial-of-service condition.

## Complete index of the 56 reviewed open entries

`patched` means an included path received a local fix. `hardened` means a related defensive bound was applied without claiming the advisory's exact behavior was reproduced. `disabled` means the reported component or triggering route is excluded from this build. `absent-code` is a source-version comparison. `fixed-base` identifies a fix already in 5.1.10. These are assessments for this custom build, not changes to the upstream CVE records. The [JSON evidence](security-advisories-2026-11-10.json) retains individual upstream references for every entry.

| Advisory | Component | Assessment |
| --- | --- | --- |
| [CVE-2026-120247](https://security-tracker.debian.org/tracker/CVE-2026-120247) | `huffyuv decoder` | **disabled** — Video decoder excluded |
| [CVE-2026-120246](https://security-tracker.debian.org/tracker/CVE-2026-120246) | `cdxl decoder` | **disabled** — Video decoder excluded |
| [CVE-2026-120245](https://security-tracker.debian.org/tracker/CVE-2026-120245) | `sunrast decoder` | **disabled** — Image decoder excluded |
| [CVE-2026-120244](https://security-tracker.debian.org/tracker/CVE-2026-120244) | `pcx decoder` | **disabled** — Image decoder excluded |
| [CVE-2026-120243](https://security-tracker.debian.org/tracker/CVE-2026-120243) | `g2m decoder` | **disabled** — Video decoder excluded |
| [CVE-2026-120210](https://security-tracker.debian.org/tracker/CVE-2026-120210) | `imf demuxer` | **disabled** — Only selected media demuxers enabled; IMF excluded |
| [CVE-2026-107697](https://security-tracker.debian.org/tracker/CVE-2026-107697) | `hls.c child playlist opening` | **patched** — Upstream protocol-policy fix backported |
| [CVE-2026-107696](https://security-tracker.debian.org/tracker/CVE-2026-107696) | `rtsp.c` | **disabled** — RTSP and native networking excluded |
| [CVE-2026-107695](https://security-tracker.debian.org/tracker/CVE-2026-107695) | `hls.c playlist recursion` | **patched** — Upstream media/master tag separation fix backported |
| [CVE-2026-107678](https://security-tracker.debian.org/tracker/CVE-2026-107678) | `encryption_info.c; mov_read_pssh` | **patched** — Iterative-free upstream fix plus project rejection of PSSH before list construction |
| [CVE-2026-107677](https://security-tracker.debian.org/tracker/CVE-2026-107677) | `dashdec.c` | **disabled** — Native DASH demuxer excluded; application parses MPD and concatenates fetched segments |
| [CVE-2026-107676](https://security-tracker.debian.org/tracker/CVE-2026-107676) | `hdr_dynamic_metadata.c` | **absent-code** — av_dynamic_hdr_plus_to_t35 does not exist in 5.1.10; source checked |
| [CVE-2026-107675](https://security-tracker.debian.org/tracker/CVE-2026-107675) | `libssh SFTP` | **disabled** — External libssh and native networking excluded |
| [CVE-2026-90816](https://security-tracker.debian.org/tracker/CVE-2026-90816) | `hlsproto.c` | **disabled** — Legacy HLS protocol excluded; distinct from enabled HLS demuxer |
| [CVE-2026-75146](https://security-tracker.debian.org/tracker/CVE-2026-75146) | `dashdec.c` | **disabled** — Native DASH demuxer excluded |
| [CVE-2026-75144](https://security-tracker.debian.org/tracker/CVE-2026-75144) | `rtpenc_vc2hq.c` | **disabled** — RTP muxer excluded |
| [CVE-2026-75143](https://security-tracker.debian.org/tracker/CVE-2026-75143) | `librist.c` | **disabled** — External librist and native networking excluded |
| [CVE-2026-75142](https://security-tracker.debian.org/tracker/CVE-2026-75142) | `mpegenc.c` | **disabled** — MPEG-PS muxers excluded |
| [CVE-2026-75141](https://security-tracker.debian.org/tracker/CVE-2026-75141) | `hevc.c hvcC count` | **hardened** — UINT16_MAX guard backported; 5.1.10 uses a different write order, so the newer heap-overflow behavior was not established |
| [CVE-2026-70632](https://security-tracker.debian.org/tracker/CVE-2026-70632) | `cfhd decoder` | **disabled** — Video decoder excluded |
| [CVE-2026-70631](https://security-tracker.debian.org/tracker/CVE-2026-70631) | `tiff decoder` | **disabled** — Image decoder and external zlib excluded |
| [CVE-2026-70630](https://security-tracker.debian.org/tracker/CVE-2026-70630) | `screenpresso decoder` | **disabled** — Video decoder excluded |
| [CVE-2026-70629](https://security-tracker.debian.org/tracker/CVE-2026-70629) | `rscc decoder` | **disabled** — Video decoder excluded |
| [CVE-2026-70628](https://security-tracker.debian.org/tracker/CVE-2026-70628) | `dvbsub parser` | **disabled** — Subtitle parser excluded |
| [CVE-2026-66041](https://security-tracker.debian.org/tracker/CVE-2026-66041) | `vf_quirc filter` | **absent-code** — Introduced after 5.1; filter and external quirc excluded |
| [CVE-2026-66040](https://security-tracker.debian.org/tracker/CVE-2026-66040) | `png/apng encoders` | **disabled** — AAC is the only encoder; image encoders excluded |
| [CVE-2026-66039](https://security-tracker.debian.org/tracker/CVE-2026-66039) | `mace6 decoder` | **disabled** — Audio decoder not in allowlist |
| [CVE-2026-66038](https://security-tracker.debian.org/tracker/CVE-2026-66038) | `lcl decoder` | **disabled** — Video decoder excluded |
| [CVE-2026-66037](https://security-tracker.debian.org/tracker/CVE-2026-66037) | `iamf_parse.c` | **absent-code** — IAMF parsing code absent from 5.1.10 |
| [CVE-2026-66036](https://security-tracker.debian.org/tracker/CVE-2026-66036) | `vf_hqdn3d filter` | **disabled** — Filter excluded |
| [CVE-2026-65706](https://security-tracker.debian.org/tracker/CVE-2026-65706) | `vf_swaprect filter` | **disabled** — Filter excluded |
| [CVE-2026-65705](https://security-tracker.debian.org/tracker/CVE-2026-65705) | `vf_floodfill filter` | **disabled** — Filter excluded |
| [CVE-2026-65704](https://security-tracker.debian.org/tracker/CVE-2026-65704) | `ty demuxer; shorten decoder` | **disabled** — Both components excluded |
| [CVE-2026-65703](https://security-tracker.debian.org/tracker/CVE-2026-65703) | `tdsc decoder` | **disabled** — Video decoder excluded |
| [CVE-2026-64835](https://security-tracker.debian.org/tracker/CVE-2026-64835) | `adx decoder` | **disabled** — Audio decoder not in allowlist |
| [CVE-2026-64834](https://security-tracker.debian.org/tracker/CVE-2026-64834) | `rtpdec_asf.c` | **disabled** — RTP demuxer and native networking excluded |
| [CVE-2026-64833](https://security-tracker.debian.org/tracker/CVE-2026-64833) | `spdif muxer` | **disabled** — Muxer excluded |
| [CVE-2026-64832](https://security-tracker.debian.org/tracker/CVE-2026-64832) | `nvdec.c` | **disabled** — Hardware acceleration excluded |
| [CVE-2026-64830](https://security-tracker.debian.org/tracker/CVE-2026-64830) | `vobsub demuxer` | **disabled** — Subtitle demuxer excluded |
| [CVE-2026-58049](https://security-tracker.debian.org/tracker/CVE-2026-58049) | `rasc decoder` | **disabled** — Video decoder excluded |
| [CVE-2026-52296](https://security-tracker.debian.org/tracker/CVE-2026-52296) | `wmaenc.c` | **disabled** — AAC is the only encoder; WMA encoders excluded |
| [CVE-2026-38350](https://security-tracker.debian.org/tracker/CVE-2026-38350) | `swscale output fuzzer` | **disabled** — Fuzzer not shipped; video decoding and scaling flow not used |
| [CVE-2026-38347](https://security-tracker.debian.org/tracker/CVE-2026-38347) | `swscale alphablend` | **fixed-base** — 5.1.10 includes upstream backport 7ee2f9004bd292cbe98deea3664dc00223d4275c |
| [CVE-2026-18393](https://security-tracker.debian.org/tracker/CVE-2026-18393) | `tdsc decoder` | **disabled** — Video decoder excluded |
| [CVE-2026-13858](https://security-tracker.debian.org/tracker/CVE-2026-13858) | `mov_seek_stream` | **absent-code** — 5.1.10 checks sample < 0 before can_seek_to_key_sample; vulnerable newer requested_sample loop absent |
| [CVE-2026-8461](https://security-tracker.debian.org/tracker/CVE-2026-8461) | `magicyuv decoder` | **fixed-base** — 5.1.10 includes upstream backport 0216a4847e6adb922c22ad18abb8b223c6290416; decoder also excluded |
| [CVE-2025-52290](https://security-tracker.debian.org/tracker/CVE-2025-52290) | `h264dec.c` | **disabled** — H264 decoder excluded; H264 parser is separate; reporter did not establish affected-version range |
| [CVE-2025-22921](https://security-tracker.debian.org/tracker/CVE-2025-22921) | `jpeg2000 decoder` | **disabled** — Image decoder excluded |
| [CVE-2025-10256](https://security-tracker.debian.org/tracker/CVE-2025-10256) | `af_firequalizer filter` | **disabled** — Filter excluded |
| [CVE-2024-36615](https://security-tracker.debian.org/tracker/CVE-2024-36615) | `vp9 decoder` | **disabled** — Video decoder and pthreads excluded |
| [CVE-2024-35369](https://security-tracker.debian.org/tracker/CVE-2024-35369) | `speex decoder` | **disabled** — Audio decoder not in allowlist |
| [CVE-2024-31578](https://security-tracker.debian.org/tracker/CVE-2024-31578) | `hardware frame context` | **disabled** — Hardware acceleration excluded; application does not create hardware frames |
| [CVE-2023-49528](https://security-tracker.debian.org/tracker/CVE-2023-49528) | `af_dialoguenhance filter` | **disabled** — Filter excluded |
| [CVE-2023-6601](https://security-tracker.debian.org/tracker/CVE-2023-6601) | `HLS data URI path` | **disabled** — data protocol excluded; generated local playlists use file protocol only |
| [CVE-2026-107660](https://security-tracker.debian.org/tracker/CVE-2026-107660) | `tls_mbedtls.c` | **disabled** — TLS backend and native networking excluded; browser handles HTTP(S) |
| [CVE-2026-30999](https://security-tracker.debian.org/tracker/CVE-2026-30999) | `tools/zmqsend.c` | **fixed-base** — Upstream fix is a zmqsend memory leak, not the advertised bprint heap overflow; tool not shipped; backport 946bf8977e64c38811c7deaf69d9d09b3168971f in 5.1.10 |
