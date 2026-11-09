# Pinned minimal FFmpeg WebAssembly core

This project embeds a **custom FFmpeg 5.1.10 + project patch set (`5.1.10-vg1`)** build. The upstream npm `@ffmpeg/core@0.12.10` binary contains FFmpeg 5.1.4 and is not used. The application loads only its packaged JavaScript and WebAssembly; no compiler, system FFmpeg, network code loader or CDN is needed at runtime.

## Inputs and verification

`vendor/ffmpeg-core/manifest.json` records exact upstream commits, source archive SHA-256 values, patch SHA-256 values and final binary SHA-256 values. It is the authoritative provenance record. The source commits are:

- FFmpeg `n5.1.10`: `19feb712f5c1821d8a3fa1ad63c5bd2e3b9672eb`
- ffmpeg.wasm bindings: `f876f907c7e9b9bf51d4ed0b913a855a63ae63fc`
- Emscripten SDK 3.1.40: `ae245715ef50e036b68a2412a323129676bf8300` (Emscripten release `c3122846bb040798aab975f61008c37eb19476de`, compiler commit `5c27e79dd0a9c4e27ef2326841698cdd4f6b5784`)

The source recipe checks archive and patch hashes before compiling. The bindings are applied as a patch to the **5.1.10 CLI source**: copying the older 5.1.4 CLI over the newer source would discard fixes and is deliberately avoided.

## Reduced build surface

The exact configure/link arguments and generated component list are in `vendor/ffmpeg-core/source/`. The core is single threaded, statically linked, and has no external codec libraries. It enables native audio decoders for AAC, MP3/MP2, Vorbis, Opus, FLAC, AC3/EAC3 and PCM, and the native AAC encoder. Video is remuxed without decoding. Video/image/subtitle decoders are disabled. HTTP, HTTPS, TCP, data URI, crypto and other network protocols are disabled; only the in-memory filesystem's `file` protocol is enabled.

Demuxers are limited to MOV/MP4, Matroska/WebM, MPEG-TS, HLS and the supported elementary audio formats. Output muxers are MP4/MOV, iPod/M4A and Matroska. The selected audio conversion filters and required bitstream parsers remain enabled. Some dependencies, such as the PGS frame merge bitstream filter for Matroska, are enabled automatically by FFmpeg; the generated `config_components.h` records the actual set.

## Local patches

- `wasm-wrapper.patch`: upstream binding changes derived against 5.1.4, applied to 5.1.10 for the FFmpeg/FFprobe callable entry points, progress and time limits.
- `CVE-2026-107695.patch`: upstream HLS self-referencing master/media playlist rejection (`a4ddaba8bb7811b1a3afaad59fe6555e720d4754`).
- `CVE-2026-107697.patch`: upstream HLS child playlist URL policy enforcement (`191715f0232cee64402c3e7733f28ff4061224b6`).
- `CVE-2026-107678.patch`: upstream iterative encryption-info list cleanup (`969c7eb091989a664cb7bf66a1f02051cc46cb52`).
- `hevc-count-bound.patch`: adapts the 16-bit NAL count guard from upstream `acf5d7cdc1f9ae8752c23e1ea8d7f355ed780781` to the older 5.1 structure. This prevents count wrap; it is not a claim that the newer version's reported heap overflow was reproduced on 5.1.10.
- `disable-pssh.patch`: rejects protected MP4 PSSH metadata before allocation/serialization. Protected media is outside the project's current scope, and this removes that parser's resource-exhaustion path.
- `parser-remux-dimensions.patch`: promotes validated H.264/HEVC SPS dimensions from the parser to the codec context only when the corresponding decoder is absent. It also forwards newly discovered child-stream dimensions to HLS parent streams, preserving MPEG-TS stream-copy remuxing without enabling video decoders. The real Chrome HLS MPEG-TS, fMP4 and byte-range download/decode tests pass with this compatibility patch.

This is a scoped review and hardening effort, not a guarantee that unknown vulnerabilities are absent. See the project's security review for advisory applicability and limitations.

## Rebuilding and modifying

Build requirements: Bash, Python 3, curl, tar, patch, make, and the platform's ordinary command-line build tools. On macOS, install Xcode Command Line Tools first. The script obtains the pinned Emscripten SDK into a new project-owned `artifacts/core-build.*` directory. It does not install a system-wide compiler or alter shell startup files.

```sh
bash scripts/build-ffmpeg-core.sh
```

The result replaces `vendor/ffmpeg-core/ffmpeg-core.js` and `.wasm`, refreshes their hashes, records the generated component configuration and writes the corresponding-source distribution. It does **not** automatically declare a rebuilt binary reviewed: rerun dependency/security checks and the real extension media tests before a release.

The release's `ffmpeg-core-5.1.10-vg1-source.tar.gz` includes the complete upstream source archives, local patches, licenses, configuration and this build recipe. Unpack it and run its `scripts/build-ffmpeg-core.sh` to rebuild or modify/relink the LGPL-covered component. The source archives are reused locally; Emscripten downloads its pinned platform-specific compiler toolchain during the first build. Source-only packaging is available with `bash scripts/build-ffmpeg-core.sh --source-only`.

The build is pinned and reproducible from its inputs. On 2026-11-10, the published source archive was unpacked into a separate directory and rebuilt with the published script and a fresh SDK installation. Both the JavaScript and WebAssembly outputs were byte-for-byte identical to the shipped files, and the generated component configuration matched. `vendor/ffmpeg-core/source/rebuild-verification.json` records the compared hashes. This verifies the tested macOS arm64/Emscripten 3.1.40 setup; identity across other host operating systems/toolchain binaries is not asserted. Build tools and logs stay inside `artifacts/`, which the project's uninstall cleanup removes.

## Licenses

This reduced FFmpeg configuration reports **LGPL-2.1-or-later**. It does not enable GPL-only external codec libraries. ffmpeg.wasm's binding code is MIT licensed. Emscripten's runtime and its libc retain their own permissive notices. Full notices are under `vendor/ffmpeg-core/licenses/` and accompany the extension. The upstream npm core's GPL package metadata describes that different, fully featured upstream binary and is not the license determination for this custom configuration.
