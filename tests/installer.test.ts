import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function temporary() { return mkdtemp(resolve(await realpath(tmpdir()), 'video-grabber-installer-')); }
async function exists(path: string) { try { await lstat(path); return true; } catch { return false; } }
async function fixture(root: string) {
  const bundle = resolve(root, 'bundle');
  await mkdir(resolve(bundle, 'scripts'), { recursive: true });
  for (const name of ['install.sh', 'uninstall.sh', 'installation-common.sh']) await cp(resolve(repo, 'scripts', name), resolve(bundle, 'scripts', name));
  for (const name of ['install.command', 'uninstall.command']) await cp(resolve(repo, name), resolve(bundle, name));
  await mkdir(resolve(bundle, 'extension'));
  await writeFile(resolve(bundle, 'extension/manifest.json'), JSON.stringify({ name: 'Video Grabber', version: '1.0.0', manifest_version: 3 }));
  await writeFile(resolve(bundle, 'extension/app.js'), 'console.log("test fixture");\n');
  await checksums(bundle);
  return bundle;
}
async function checksums(root: string) {
  const lines: string[] = [];
  async function walk(path: string) {
    for (const file of await readdir(path, { withFileTypes: true })) {
      const full = resolve(path, file.name);
      if (file.isDirectory()) await walk(full);
      else if (file.name !== 'SHA256SUMS') lines.push(`${createHash('sha256').update(await readFile(full)).digest('hex')}  ${full.slice(root.length + 1)}`);
    }
  }
  await walk(root);
  await writeFile(resolve(root, 'SHA256SUMS'), lines.join('\n') + '\n');
}
function run(bundle: string, script: 'install' | 'uninstall', target: string, options: string[] = []) {
  return spawnSync('/bin/bash', [resolve(bundle, 'scripts', `${script}.sh`), '--no-open', '--target-root', target, ...options], { encoding: 'utf8' });
}

test('release staging needs no npm, updates atomically, and uninstall removes owned payload and logs', async () => {
  const root = await temporary();
  try {
    const bundle = await fixture(root);
    const target = resolve(root, 'managed/video-grabber');
    let result = run(bundle, 'install', target);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(resolve(target, '.video-grabber-owned'), 'utf8'), 'video-grabber-install-v1\n');
    assert.equal(await exists(resolve(target, 'logs/install.log')), true);
    await writeFile(resolve(target, 'cache/old.bin'), 'cached bytes');
    result = run(bundle, 'install', target);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await exists(resolve(target, 'cache/old.bin')), false);
    result = run(target, 'uninstall', target, ['--browser-removed']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await exists(target), false);
    result = run(bundle, 'uninstall', target, ['--browser-removed']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await exists(resolve(bundle, 'extension/manifest.json')), true, 'original downloaded package is not a managed installation');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('uninstall waits for Chrome removal confirmation and does not partially erase files', async () => {
  const root = await temporary();
  try {
    const bundle = await fixture(root);
    const target = resolve(root, 'managed/video-grabber');
    assert.equal(run(bundle, 'install', target).status, 0);
    const result = run(bundle, 'uninstall', target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /browser-removed/);
    assert.equal(await exists(resolve(target, 'extension/manifest.json')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('foreign folders and unsafe or symlink targets are refused without deleting unrelated data', async () => {
  const root = await temporary();
  try {
    const bundle = await fixture(root);
    const foreign = resolve(root, 'foreign/video-grabber');
    await mkdir(foreign, { recursive: true });
    await writeFile(resolve(foreign, 'important.txt'), 'keep');
    assert.notEqual(run(bundle, 'install', foreign).status, 0);
    assert.notEqual(run(bundle, 'uninstall', foreign, ['--browser-removed']).status, 0);
    assert.equal(await readFile(resolve(foreign, 'important.txt'), 'utf8'), 'keep');
    await symlink(resolve(root, 'foreign'), resolve(root, 'link'));
    assert.notEqual(run(bundle, 'install', resolve(root, 'link/video-grabber')).status, 0);
    for (const target of ['/', '/video-grabber', root, 'relative/video-grabber', `${root}/../video-grabber`]) {
      assert.notEqual(run(bundle, 'install', target).status, 0, target);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('release integrity rejects modified, unlisted, missing-checksum and symlink payloads', async () => {
  const root = await temporary();
  try {
    const bundle = await fixture(root);
    const target = resolve(root, 'managed/video-grabber');
    await writeFile(resolve(bundle, 'extension/app.js'), 'tampered');
    assert.notEqual(run(bundle, 'install', target).status, 0);
    await checksums(bundle);
    await writeFile(resolve(bundle, 'extension/unlisted.js'), 'unlisted');
    assert.notEqual(run(bundle, 'install', target).status, 0);
    await rm(resolve(bundle, 'extension/unlisted.js'));
    await symlink(resolve(root, 'outside'), resolve(bundle, 'extension/link'));
    assert.notEqual(run(bundle, 'install', target).status, 0);
    await rm(resolve(bundle, 'extension/link'));
    await rm(resolve(bundle, 'SHA256SUMS'));
    assert.notEqual(run(bundle, 'install', target).status, 0);
    assert.equal(await exists(target), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source cleanup deletes allowlisted artifacts while preserving source, git and videos', async () => {
  const root = await temporary();
  try {
    const bundle = await fixture(root);
    const target = resolve(root, 'managed/video-grabber');
    await mkdir(resolve(bundle, '.git'));
    await mkdir(resolve(bundle, 'src'));
    await mkdir(resolve(bundle, 'public'));
    await writeFile(resolve(bundle, 'src/background.ts'), 'source');
    await writeFile(resolve(bundle, 'public/manifest.json'), '{}');
    await writeFile(resolve(bundle, 'package.json'), '{"name":"video-grabber"}');
    await writeFile(resolve(bundle, 'package-lock.json'), '{}');
    for (const name of ['node_modules', 'dist', 'artifacts', 'fixtures/media', '.cache', '.logs']) {
      await mkdir(resolve(bundle, name), { recursive: true });
      await writeFile(resolve(bundle, name, 'artifact'), 'generated');
    }
    await writeFile(resolve(bundle, 'saved-video.mp4'), 'user data');
    const result = run(bundle, 'uninstall', target, ['--browser-removed']);
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['node_modules', 'dist', 'artifacts', 'fixtures/media', '.cache', '.logs']) assert.equal(await exists(resolve(bundle, name)), false, name);
    for (const name of ['.git', 'src/background.ts', 'saved-video.mp4']) assert.equal(await exists(resolve(bundle, name)), true, name);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a symlink in the source cleanup allowlist aborts all cleanup', async () => {
  const root = await temporary();
  try {
    const bundle = await fixture(root);
    await mkdir(resolve(bundle, '.git'));
    await mkdir(resolve(bundle, 'src'));
    await mkdir(resolve(bundle, 'public'));
    await mkdir(resolve(bundle, 'artifacts'));
    await writeFile(resolve(bundle, 'src/background.ts'), 'source');
    await writeFile(resolve(bundle, 'public/manifest.json'), '{}');
    await writeFile(resolve(bundle, 'package.json'), '{"name":"video-grabber"}');
    await writeFile(resolve(bundle, 'package-lock.json'), '{}');
    const outside = resolve(root, 'important');
    await mkdir(outside);
    await writeFile(resolve(outside, 'keep.txt'), 'keep');
    await symlink(outside, resolve(bundle, 'node_modules'));
    const result = run(bundle, 'uninstall', resolve(root, 'managed/video-grabber'), ['--browser-removed']);
    assert.notEqual(result.status, 0);
    assert.equal(await exists(resolve(bundle, 'artifacts')), true, 'validate all paths before any deletion');
    assert.equal(await readFile(resolve(outside, 'keep.txt'), 'utf8'), 'keep');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed uninstaller verifies recorded source ownership and removes its build dependencies', async () => {
  const root = await temporary();
  try {
    const bundle = await fixture(root);
    await rm(resolve(bundle, 'extension'), { recursive: true });
    await rm(resolve(bundle, 'SHA256SUMS'));
    await mkdir(resolve(bundle, 'src'));
    await mkdir(resolve(bundle, 'public'));
    await writeFile(resolve(bundle, 'src/background.ts'), 'source');
    await writeFile(resolve(bundle, 'public/manifest.json'), '{"name":"Video Grabber","manifest_version":3,"version":"1.0.0"}');
    await writeFile(resolve(bundle, 'package.json'), '{"name":"video-grabber"}');
    await writeFile(resolve(bundle, 'package-lock.json'), '{}');
    const bin = resolve(root, 'bin');
    await mkdir(bin);
    await writeFile(resolve(bin, 'npm'), '#!/bin/bash\nset -eu\nprintf "%s\\n" "$*" >> npm-invocations.txt\nif [ "$1" = ci ]; then mkdir -p node_modules; else mkdir -p dist; cp public/manifest.json dist/manifest.json; fi\n');
    await chmod(resolve(bin, 'npm'), 0o700);
    const target = resolve(root, 'managed/video-grabber');
    const installed = spawnSync('/bin/bash', [resolve(bundle, 'scripts/install.sh'), '--no-open', '--target-root', target], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(await readFile(resolve(bundle, 'npm-invocations.txt'), 'utf8'), /ci --ignore-scripts --cache/);
    assert.equal(await readFile(resolve(target, 'source-root.txt'), 'utf8'), `${bundle}\n`);
    await writeFile(resolve(bundle, '.video-grabber-build-root'), 'foreign marker');
    let result = run(target, 'uninstall', target, ['--browser-removed']);
    assert.notEqual(result.status, 0);
    assert.equal(await exists(resolve(bundle, 'node_modules')), true);
    assert.equal(await exists(target), true);
    await writeFile(resolve(bundle, '.video-grabber-build-root'), `video-grabber-build-v1\n${bundle}\n`);
    result = run(target, 'uninstall', target, ['--browser-removed']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await exists(resolve(bundle, 'node_modules')), false);
    assert.equal(await exists(resolve(bundle, 'dist')), false);
    assert.equal(await exists(resolve(bundle, '.video-grabber-build-root')), false);
    assert.equal(await exists(target), false);
    assert.equal(await exists(resolve(bundle, 'src/background.ts')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source installs reject destinations inside the checkout before npm or staging can alter existing installs', async () => {
  const root = await temporary();
  try {
    const bundle = await fixture(root);
    await rm(resolve(bundle, 'extension'), { recursive: true });
    await rm(resolve(bundle, 'SHA256SUMS'));
    await mkdir(resolve(bundle, 'src'));
    await mkdir(resolve(bundle, 'public'));
    await writeFile(resolve(bundle, 'src/background.ts'), 'source');
    await writeFile(resolve(bundle, 'public/manifest.json'), '{"name":"Video Grabber"}');
    await writeFile(resolve(bundle, 'package.json'), '{"name":"video-grabber"}');
    await writeFile(resolve(bundle, 'package-lock.json'), '{}');
    const bin = resolve(root, 'bin');
    await mkdir(bin);
    await writeFile(resolve(bin, 'npm'), '#!/bin/bash\nprintf "must not run\\n" > npm-was-run\nexit 1\n');
    await chmod(resolve(bin, 'npm'), 0o700);
    for (const artifact of ['node_modules', 'dist', 'artifacts', 'fixtures/media', '.cache', '.logs', 'custom']) {
      const parent = resolve(bundle, artifact);
      const target = resolve(parent, 'video-grabber');
      await mkdir(target, { recursive: true });
      await writeFile(resolve(target, '.video-grabber-owned'), 'video-grabber-install-v1\n');
      await writeFile(resolve(target, 'previous-install.bin'), 'keep this installed payload');
      const result = spawnSync('/bin/bash', [resolve(bundle, 'scripts/install.sh'), '--no-open', '--target-root', target], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      assert.notEqual(result.status, 0, artifact);
      assert.match(result.stderr, /소스 체크아웃 밖/, artifact);
      assert.equal(await readFile(resolve(target, 'previous-install.bin'), 'utf8'), 'keep this installed payload');
      assert.deepEqual(await readdir(parent), ['video-grabber'], 'no staging/backup directory is created in source artifacts');
      assert.equal(await exists(resolve(bundle, 'npm-was-run')), false, 'npm must never run for a rejected destination');
      assert.equal(await exists(resolve(bundle, '.video-grabber-build-root')), false, 'source marker must not be created before validation');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
