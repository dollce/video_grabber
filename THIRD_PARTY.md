# Third-party components

The extension packages its media processing code locally. No executable code is downloaded from a CDN at runtime.

| Component | Version | Upstream license | Source |
| --- | --- | --- | --- |
| @ffmpeg/ffmpeg | 0.12.15 | MIT | https://github.com/ffmpegwasm/ffmpeg.wasm |
| Custom FFmpeg WebAssembly core | 5.1.10-vg1 | LGPL-2.1-or-later; wrapper glue MIT | vendor/ffmpeg-core/manifest.json |
| fast-xml-parser | See package-lock.json | MIT | https://github.com/NaturalIntelligence/fast-xml-parser |

The custom FFmpeg core is statically compiled WebAssembly from FFmpeg 5.1.10 with project patches and ffmpeg.wasm wrapper glue. It does not include the stock `@ffmpeg/core` binary or external codec libraries. GPL/nonfree components, video decoders and native network protocols are disabled. Its pinned source, build options, patch hashes, toolchain and output hashes are recorded in `vendor/ffmpeg-core/manifest.json`; see [build instructions](docs/FFMPEG_BUILD.md) and [security review](SECURITY.md).

The GitHub release supplies the corresponding FFmpeg source, exact patches, wrapper source and build recipe in `ffmpeg-core-5.1.10-vg1-source.tar.gz`. The local core can be rebuilt and substituted using that recipe. License texts are bundled under `vendor/ffmpeg-core/licenses` and distributed with the extension. The JavaScript wrapper's MIT license does not replace the core's LGPL terms. Upstream licensing: [FFmpeg](https://ffmpeg.org/legal.html), [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm).

The build writes available package license texts and package metadata to `dist/THIRD_PARTY_LICENSES.txt`. Development-only tools, including hls.js for the synthetic fixture player, are not bundled in the extension.
