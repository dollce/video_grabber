import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const mediaDir = resolve(root, 'fixtures/media');
export const ffmpegPath = process.env.FFMPEG || 'ffmpeg';
export function nativeFFmpeg(args) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', cwd: mediaDir });
  if (result.error || result.status !== 0) throw new Error(`FFmpeg failed. Set FFMPEG to a native ffmpeg executable.\n${result.error?.message ?? result.stderr}`);
  return result;
}
export async function generateFixtures() {
  await mkdir(mediaDir, { recursive: true });
  try { await stat(resolve(mediaDir, 'ready-v1')); return; } catch { /* generate once */ }
  nativeFFmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-profile:v', 'baseline', '-level:v', '3.0', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-g', '24', '-keyint_min', '24', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', 'direct.mp4']);
  nativeFFmpeg(['-i', 'direct.mp4', '-an', '-c:v', 'copy', 'video-only.mp4']);
  nativeFFmpeg(['-i', 'direct.mp4', '-vn', '-c:a', 'copy', 'audio.m4a']);
  for (const [name, map] of [['video', '0:v:0'], ['audio', '0:a:0']]) {
    nativeFFmpeg(['-i', 'direct.mp4', '-map', map, '-c', 'copy', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_filename', `${name}-%03d.ts`, `${name}.m3u8`]);
    nativeFFmpeg(['-i', 'direct.mp4', '-map', map, '-c', 'copy', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', `${name}-init.mp4`, '-hls_segment_filename', `${name}-%03d.m4s`, `${name}-fmp4.m3u8`]);
  }
  const master = (suffix = '') => `#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="Test audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio${suffix}.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x180,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="sound"\nvideo${suffix}.m3u8\n`;
  await writeFile(resolve(mediaDir, 'master.m3u8'), master());
  await writeFile(resolve(mediaDir, 'master-fmp4.m3u8'), master('-fmp4'));
  nativeFFmpeg(['-i', 'direct.mp4', '-c', 'copy', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_flags', 'single_file', '-hls_segment_type', 'fmp4', 'range.m3u8']);
  nativeFFmpeg(['-i', 'direct.mp4', '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'dash', '-seg_duration', '1', '-use_template', '1', '-use_timeline', '1', '-adaptation_sets', 'id=0,streams=v id=1,streams=a', 'stream.mpd']);
  await writeFile(resolve(mediaDir, 'ready-v1'), 'Synthetic local test media, 4 seconds with 440 Hz audio.\n');
}

export async function startFixtureServer(port = 0) {
  const blocked = new Set();
  const requests = [];
  const redirects = new Map([
    ['/redirect-hls/video.m3u8', '/relocated-hls/video/video.m3u8'],
    ['/redirect-hls/audio.m3u8', '/relocated-hls/audio/audio.m3u8'],
  ]);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push({ path: url.pathname, range: request.headers.range });
    if (blocked.has(url.pathname)) { response.writeHead(403); response.end('Replay disabled by test'); return; }
    if (redirects.has(url.pathname)) {
      response.writeHead(302, { Location: redirects.get(url.pathname), 'Cache-Control': 'no-store' });
      response.end(); return;
    }
    // The DASH address is moved after playback discovers it, so the extension
    // must resolve child files against the new URL instead of its catalog URL.
    if (redirects.has('/redirect-dash/stream.mpd') && url.pathname.startsWith('/redirect-dash/')) {
      response.writeHead(404); response.end('Media moved with its manifest'); return;
    }
    try {
      let path;
      if (url.pathname === '/') path = resolve(root, 'fixtures/index.html');
      else if (url.pathname === '/player.js') path = resolve(root, 'fixtures/player.js');
      else if (url.pathname === '/hls.js') path = resolve(root, 'node_modules/hls.js/dist/hls.js');
      else {
        const relocated = /^\/(?:relocated-hls\/(?:video|audio)|redirect-dash|relocated-dash)\/([^/]+)$/.exec(url.pathname);
        const mediaPath = url.pathname === '/redirect-hls/master.m3u8' ? '/master.m3u8' : relocated ? `/${relocated[1]}` : url.pathname;
        path = resolve(mediaDir, '.' + decodeURIComponent(mediaPath));
        if (!path.startsWith(mediaDir + sep)) throw new Error('Invalid path');
      }
      const data = await readFile(path);
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.ts': 'video/mp2t', '.m4s': 'video/iso.segment', '.m3u8': 'application/vnd.apple.mpegurl', '.mpd': 'application/dash+xml', '.m4v': 'video/mp4' }[extname(path)] ?? 'application/octet-stream';
      response.setHeader('Content-Type', mime);
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Accept-Ranges', 'bytes');
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(range[2] ? Number(range[2]) : data.length - 1, data.length - 1);
        if (start > end) { response.writeHead(416); response.end(); return; }
        response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
        response.end(data.subarray(start, end + 1));
      } else { response.writeHead(200, { 'Content-Length': data.length }); response.end(data); }
    } catch { response.writeHead(404); response.end('Not found'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}`, blocked, requests, redirects };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await generateFixtures();
  if (!process.argv.includes('--generate-only')) {
    const { url } = await startFixtureServer(Number(process.env.PORT || 8765));
    console.log(`Fixture player: ${url}`);
  } else console.log(`Generated ${mediaDir}`);
}
