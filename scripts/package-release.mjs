import { cp, mkdir, readFile, readdir, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyVendor } from './verify-vendor.mjs';

const vendor = await verifyVendor();
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const audit = JSON.parse(await readFile('artifacts/security/npm-audit.json', 'utf8'));
if (audit.metadata?.vulnerabilities?.total !== 0 || Date.now() - Date.parse(audit.checkedAt) > 86_400_000 || !Number.isFinite(Date.parse(audit.checkedAt))) {
  throw new Error('Run npm run security:check before packaging; a recent completed audit is required.');
}
function run(command, args, cwd) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
run(process.execPath, ['scripts/build.mjs']);
const name = `video-grabber-${pkg.version}`;
const releaseDir = resolve('artifacts/release');
const sourceName = `ffmpeg-core-${vendor.version}-source.tar.gz`;
const sourceArchive = resolve(releaseDir, sourceName);
const sourceManifest = JSON.parse(run('tar', ['-xOf', sourceArchive, `ffmpeg-core-${vendor.version}-source/vendor/ffmpeg-core/manifest.json`]));
if (JSON.stringify(sourceManifest) !== JSON.stringify(vendor)) throw new Error('Corresponding-source provenance does not match the packaged core. Rebuild the source archive before release.');
const stage = resolve(releaseDir, name);
await mkdir(releaseDir, { recursive: true });
await rm(stage, { recursive: true, force: true });
await mkdir(resolve(stage, 'scripts'), { recursive: true });
await cp('dist', resolve(stage, 'extension'), { recursive: true });
for (const file of ['install.command', 'uninstall.command', 'README.md', 'THIRD_PARTY.md', 'SECURITY.md', 'VALIDATION.md']) {
  await cp(file, resolve(stage, file));
}
for (const file of ['install.sh', 'uninstall.sh', 'installation-common.sh']) await cp(`scripts/${file}`, resolve(stage, 'scripts', file));
await cp('docs/INSTALLATION.md', resolve(stage, 'INSTALLATION.md'));
await cp('docs', resolve(stage, 'docs'), { recursive: true });
for (const file of ['install.command', 'uninstall.command', 'scripts/install.sh', 'scripts/uninstall.sh']) await chmod(resolve(stage, file), 0o755);
const sbom = JSON.parse(run('npm', ['sbom', '--omit=dev', '--sbom-format', 'cyclonedx']));
sbom.components ??= [];
sbom.components.push({ type: 'library', name: 'FFmpeg (custom minimal WebAssembly core)', version: vendor.version ?? '5.1.10',
  'bom-ref': 'ffmpeg-core-custom', hashes: [{ alg: 'SHA-256', content: vendor.sha256['ffmpeg-core.wasm'] }],
  properties: [{ name: 'provenance', value: 'extension/vendor/core/manifest.json' }] });
await writeFile(resolve(stage, 'SBOM.cdx.json'), JSON.stringify(sbom, null, 2) + '\n');
await cp('artifacts/security/npm-audit.json', resolve(stage, 'npm-audit.json'));
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Release contains a symlink');
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) files.push(path);
  }
}
await walk(stage);
const hashes = await Promise.all(files.sort().map(async path => `${createHash('sha256').update(await readFile(path)).digest('hex')}  ${relative(stage, path)}`));
await writeFile(resolve(stage, 'SHA256SUMS'), hashes.join('\n') + '\n');
const archive = resolve(releaseDir, `${name}.zip`);
await rm(archive, { force: true });
run('zip', ['-qrX', archive, name], releaseDir);
const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
const sourceDigest = createHash('sha256').update(await readFile(sourceArchive)).digest('hex');
await writeFile(resolve(releaseDir, 'SHA256SUMS'), `${digest}  ${name}.zip\n${sourceDigest}  ${sourceName}\n`);
console.log(`Packaged ${archive} (${(await stat(archive)).size} bytes)`);
