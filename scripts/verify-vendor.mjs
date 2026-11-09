import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export async function verifyVendor() {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error(`Dependency must have an exact version: ${name}`);
    const installed = lock.packages[`node_modules/${name}`];
    if (installed?.version !== version || !installed.integrity?.startsWith('sha512-')) throw new Error(`Missing matching locked integrity: ${name}`);
  }
  const base = resolve('vendor/ffmpeg-core');
  const provenance = JSON.parse(await readFile(resolve(base, 'manifest.json'), 'utf8'));
  for (const filename of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
    const expected = provenance.sha256?.[filename];
    if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error(`Missing vendor digest: ${filename}`);
    const actual = createHash('sha256').update(await readFile(resolve(base, filename))).digest('hex');
    if (expected !== actual) throw new Error(`Vendor integrity mismatch: ${filename}`);
  }
  for (const [filename, expected] of Object.entries(provenance.patches ?? {})) {
    if (!/^[a-zA-Z0-9._-]+\.patch$/.test(filename)) throw new Error('Invalid patch filename');
    const actual = createHash('sha256').update(await readFile(resolve(base, 'source/patches', filename))).digest('hex');
    if (actual !== expected) throw new Error(`Patch integrity mismatch: ${filename}`);
  }
  const config = await readFile(resolve(base, 'source/config_components.h'));
  if (createHash('sha256').update(config).digest('hex') !== provenance.build?.configurationSha256) throw new Error('Native component configuration hash mismatch');
  const enabledProtocols = [...config.toString().matchAll(/^#define CONFIG_(\w+)_PROTOCOL 1$/gm)].map(match => match[1]);
  if (enabledProtocols.length !== 1 || enabledProtocols[0] !== 'FILE') throw new Error('Native protocols must be restricted to file');
  const manifest = JSON.parse(await readFile('public/manifest.json', 'utf8'));
  if (manifest.version !== pkg.version) throw new Error('Package and extension versions differ');
  const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  if ((await readFile('public/extension-id.txt', 'utf8')).trim() !== id) throw new Error('Extension identity mismatch');
  return provenance;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/verify-vendor.mjs')) {
  await verifyVendor();
  console.log('Exact dependency versions, lockfile integrity, vendor digests and extension identity verified.');
}
