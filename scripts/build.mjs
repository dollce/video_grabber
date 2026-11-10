import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { verifyVendor } from './verify-vendor.mjs';

await verifyVendor();

await rm('dist', { recursive: true, force: true });
await mkdir('dist/vendor', { recursive: true });
await cp('public', 'dist', { recursive: true });
await cp('src/app.css', 'dist/app.css');
await cp('README.md', 'dist/README.md');
await cp('THIRD_PARTY.md', 'dist/THIRD_PARTY.md');
await cp('SECURITY.md', 'dist/SECURITY.md');
await cp('docs', 'dist/docs', { recursive: true });
await build({
  entryPoints: ['src/background.ts', 'src/app.ts', 'src/uninstall.ts'],
  bundle: true,
  outdir: 'dist',
  format: 'esm',
  target: 'chrome125',
  sourcemap: true,
  legalComments: 'eof',
});
await cp('node_modules/@ffmpeg/ffmpeg/dist/esm', 'dist/vendor/ffmpeg', { recursive: true });
await mkdir('dist/vendor/core', { recursive: true });
for (const filename of ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'manifest.json']) await cp(`vendor/ffmpeg-core/${filename}`, `dist/vendor/core/${filename}`);
await cp('vendor/ffmpeg-core/licenses', 'dist/vendor/core/licenses', { recursive: true });
const notices = [];
for (const name of ['@ffmpeg/ffmpeg', 'fast-xml-parser']) {
  const metadata = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'));
  notices.push(`${name}@${metadata.version}\nLicense: ${metadata.license}\nRepository: ${typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url}`);
  for (const filename of ['LICENSE', 'LICENSE.md']) {
    try {
      notices.push(`${name}\n${await readFile(`node_modules/${name}/${filename}`, 'utf8')}`);
      break;
    } catch { /* Some packages publish their license as package metadata only. */ }
  }
}
notices.push(`Custom FFmpeg core: see vendor/core/manifest.json and vendor/core/licenses. Corresponding source is supplied with the GitHub release.`);
await writeFile('dist/THIRD_PARTY_LICENSES.txt', notices.join('\n\n'));
console.log('Built dist/ — load this directory as an unpacked Chrome extension.');
