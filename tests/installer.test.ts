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
async function sourceFixture(root: string, name: string) {
  const bundle = await fixture(resolve(root, name));
  await rm(resolve(bundle, 'extension'), { recursive: true });
  await rm(resolve(bundle, 'SHA256SUMS'));
  for (const directory of ['.git', 'src', 'public']) await mkdir(resolve(bundle, directory));
  await writeFile(resolve(bundle, 'src/background.ts'), 'source');
  await writeFile(resolve(bundle, '.git/keep'), 'git data');
  await writeFile(resolve(bundle, 'saved-video.mp4'), 'user video');
  await writeFile(resolve(bundle, 'public/manifest.json'), '{"name":"Video Grabber","manifest_version":3,"version":"1.0.0"}');
  await writeFile(resolve(bundle, 'package.json'), '{"name":"video-grabber"}');
  await writeFile(resolve(bundle, 'package-lock.json'), '{}');
  return bundle;
}
async function fakeNpm(root: string) {
  const bin = resolve(root, 'fake-npm-bin');
  await mkdir(bin);
  await writeFile(resolve(bin, 'npm'), '#!/bin/bash\nset -eu\nprintf "%s\\n" "$*" >> npm-invocations.txt\nif [ "$1" = ci ]; then mkdir -p node_modules; printf dependency > node_modules/installed; else mkdir -p dist; cp public/manifest.json dist/manifest.json; fi\n');
  await chmod(resolve(bin, 'npm'), 0o700);
  return bin;
}
function installSource(bundle: string, target: string, bin: string) {
  return spawnSync('/bin/bash', [resolve(bundle, 'scripts/install.sh'), '--no-open', '--target-root', target], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}
async function assertSourcePreserved(path: string) {
  assert.equal(await readFile(resolve(path, 'src/background.ts'), 'utf8'), 'source');
  assert.equal(await readFile(resolve(path, '.git/keep'), 'utf8'), 'git data');
  assert.equal(await readFile(resolve(path, 'saved-video.mp4'), 'utf8'), 'user video');
}
const sourceArtifacts = ['node_modules', 'dist', 'artifacts', 'fixtures/media', '.cache', '.logs', '.video-grabber-build-root'];
async function assertSourceCleaned(path: string) {
  for (const name of sourceArtifacts) assert.equal(await exists(resolve(path, name)), false, `${path}/${name}`);
  await assertSourcePreserved(path);
}
async function realNpmSource(root: string, name: string) {
  const source = await sourceFixture(root, name);
  const pkg = { name: 'video-grabber', version: '1.0.0', private: true, scripts: { build: 'node scripts/build-fixture.cjs' } };
  await writeFile(resolve(source, 'package.json'), JSON.stringify(pkg));
  await writeFile(resolve(source, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name, version: pkg.version } } }));
  await writeFile(resolve(source, 'scripts/build-fixture.cjs'), `
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
fs.mkdirSync('dist', { recursive: true });
fs.mkdirSync('node_modules', { recursive: true });
fs.writeFileSync('node_modules/generated', 'local build output');
fs.copyFileSync('public/manifest.json', 'dist/manifest.json');
const config = key => execFileSync(process.execPath, [process.env.npm_execpath, 'config', 'get', key], { encoding: 'utf8' }).trim();
fs.writeFileSync('dist/npm-settings.json', JSON.stringify({ cache: process.env.npm_config_cache, logs: process.env.npm_config_logs_dir, nestedCache: config('cache'), nestedLogs: config('logs-dir') }));
if (process.env.VIDEO_GRABBER_TEST_FAIL_BUILD === '1') process.exit(1);
`);
  return source;
}
async function isolatedNpmEnvironment(root: string) {
  const cache = resolve(root, 'external-npm-cache');
  const logs = resolve(root, 'external-npm-logs');
  const config = resolve(root, 'isolated.npmrc');
  for (const path of [cache, logs]) { await mkdir(path); await writeFile(resolve(path, 'keep.txt'), 'unrelated'); }
  await writeFile(config, `cache=${cache}\nlogs-dir=${logs}\n`);
  return {
    ...process.env, npm_config_cache: cache, NPM_CONFIG_CACHE: cache,
    npm_config_logs_dir: logs, NPM_CONFIG_LOGS_DIR: logs,
    npm_config_userconfig: config, NPM_CONFIG_USERCONFIG: config,
    npm_config_offline: 'true', NPM_CONFIG_OFFLINE: 'true',
    npm_config_audit: 'false', NPM_CONFIG_AUDIT: 'false',
    npm_config_fund: 'false', NPM_CONFIG_FUND: 'false',
    npm_config_update_notifier: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
}
function installWithNpm(source: string, target: string, env: NodeJS.ProcessEnv) {
  return spawnSync('/bin/bash', [resolve(source, 'scripts/install.sh'), '--no-open', '--target-root', target], { encoding: 'utf8', env });
}
async function assertExternalNpmUntouched(root: string) {
  for (const name of ['external-npm-cache', 'external-npm-logs']) {
    const path = resolve(root, name);
    assert.deepEqual(await readdir(path), ['keep.txt']);
    assert.equal(await readFile(resolve(path, 'keep.txt'), 'utf8'), 'unrelated');
  }
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
    assert.equal(await readFile(resolve(target, 'source-roots.txt'), 'utf8'), `${bundle}\n`);
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

test('source installs reject case aliases before npm or staging can alter existing installs', async (context) => {
  const root = await temporary();
  try {
    const source = await sourceFixture(root, 'source');
    const alias = resolve(root, 'SOURCE/BUNDLE');
    if (!await exists(alias)) return context.skip('The temporary filesystem distinguishes case aliases.');
    const originalStat = await lstat(source);
    const aliasStat = await lstat(alias);
    assert.equal(aliasStat.dev, originalStat.dev);
    assert.equal(aliasStat.ino, originalStat.ino);
    const bin = await fakeNpm(root);
    for (const artifact of ['node_modules', 'dist', 'artifacts', 'fixtures/media', '.cache', '.logs', 'custom']) {
      const parent = resolve(source, artifact);
      const target = resolve(parent, 'video-grabber');
      await mkdir(target, { recursive: true });
      await writeFile(resolve(target, '.video-grabber-owned'), 'video-grabber-install-v1\n');
      await writeFile(resolve(target, 'previous-install.bin'), 'existing installation');
      const result = installSource(source, resolve(alias, artifact, 'video-grabber'), bin);
      assert.notEqual(result.status, 0, artifact);
      assert.match(result.stderr, /소스 체크아웃 밖/, artifact);
      assert.equal(await readFile(resolve(target, 'previous-install.bin'), 'utf8'), 'existing installation');
      assert.deepEqual(await readdir(parent), ['video-grabber'], 'no stage or backup may be created');
    }
    const absentParent = resolve(alias, 'not-created/nested');
    const absent = installSource(source, resolve(absentParent, 'video-grabber'), bin);
    assert.notEqual(absent.status, 0);
    assert.match(absent.stderr, /소스 체크아웃 밖/);
    assert.equal(await exists(resolve(source, 'not-created')), false, 'missing parent must stay absent');
    assert.equal(await exists(resolve(source, 'npm-invocations.txt')), false, 'npm must not run');
    assert.equal(await exists(resolve(source, '.video-grabber-build-root')), false, 'validation precedes source marker creation');
    await assertSourcePreserved(source);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source installation permits distinct sibling paths using the filesystem case rules', async () => {
  const root = await temporary();
  try {
    const source = await sourceFixture(root, 'source');
    const bin = await fakeNpm(root);
    const siblingTarget = `${source}-sibling/video-grabber`;
    const installed = installSource(source, siblingTarget, bin);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(run(siblingTarget, 'uninstall', siblingTarget, ['--browser-removed']).status, 0);
    const caseDistinct = resolve(root, 'SOURCE/BUNDLE');
    if (!await exists(caseDistinct)) {
      const caseTarget = resolve(caseDistinct, 'node_modules/video-grabber');
      const installedCase = installSource(source, caseTarget, bin);
      assert.equal(installedCase.status, 0, installedCase.stderr);
      assert.equal(run(caseTarget, 'uninstall', caseTarget, ['--browser-removed']).status, 0);
    }
    await assertSourcePreserved(source);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('uninstall refuses case-alias source history contained in another source artifact directory', async (context) => {
  const root = await temporary();
  try {
    const sourceA = await sourceFixture(root, 'source-a');
    const sourceB = await sourceFixture(resolve(sourceA, 'NODE_MODULES'), 'source-b');
    if (!await exists(resolve(sourceA, 'node_modules/source-b/bundle'))) return context.skip('The temporary filesystem distinguishes case aliases.');
    const release = await fixture(resolve(root, 'release'));
    const target = resolve(root, 'managed/video-grabber');
    assert.equal(run(release, 'install', target).status, 0);
    for (const source of [sourceA, sourceB]) {
      await writeFile(resolve(source, '.video-grabber-build-root'), `video-grabber-build-v1\n${source}\n`);
      await mkdir(resolve(source, 'dist'));
      await writeFile(resolve(source, 'dist/generated'), 'owned artifact');
    }
    await writeFile(resolve(target, 'source-roots.txt'), `${sourceA}\n${sourceB}\n`);
    const removed = run(target, 'uninstall', target, ['--browser-removed']);
    assert.notEqual(removed.status, 0);
    assert.match(removed.stderr, /다른 소스의 삭제 대상/);
    for (const source of [sourceA, sourceB]) {
      await assertSourcePreserved(source);
      assert.equal(await readFile(resolve(source, 'dist/generated'), 'utf8'), 'owned artifact');
      assert.equal(await exists(resolve(source, '.video-grabber-build-root')), true);
    }
    assert.equal(await exists(resolve(target, 'extension/manifest.json')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source A to B to release upgrades retain deduplicated provenance and remove artifacts from every checkout', async () => {
  const root = await temporary();
  try {
    const sourceA = await sourceFixture(root, 'source-a');
    const sourceB = await sourceFixture(root, 'source-b');
    const release = await fixture(resolve(root, 'release'));
    const bin = await fakeNpm(root);
    const target = resolve(root, 'managed/video-grabber');
    for (const source of [sourceA, sourceB, sourceA]) {
      const installed = installSource(source, target, bin);
      assert.equal(installed.status, 0, installed.stderr);
    }
    assert.equal(await readFile(resolve(target, 'source-roots.txt'), 'utf8'), `${sourceA}\n${sourceB}\n`);
    for (const source of [sourceA, sourceB]) {
      for (const name of ['artifacts', 'fixtures/media', '.cache', '.logs']) {
        await mkdir(resolve(source, name), { recursive: true });
        await writeFile(resolve(source, name, 'generated'), 'artifact');
      }
    }
    const upgraded = run(release, 'install', target);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.equal(await readFile(resolve(target, 'source-roots.txt'), 'utf8'), `${sourceA}\n${sourceB}\n`);
    const removed = run(target, 'uninstall', target, ['--browser-removed']);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(await exists(target), false);
    for (const source of [sourceA, sourceB]) {
      for (const name of ['node_modules', 'dist', 'artifacts', 'fixtures/media', '.cache', '.logs', '.video-grabber-build-root']) {
        assert.equal(await exists(resolve(source, name)), false, `${source}/${name}`);
      }
      await assertSourcePreserved(source);
    }
    assert.equal(await exists(resolve(release, 'extension/manifest.json')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy single-source metadata is imported on upgrade and read by a checkout uninstaller alongside its own artifacts', async () => {
  const root = await temporary();
  try {
    const sourceA = await sourceFixture(root, 'legacy-source');
    const sourceB = await sourceFixture(root, 'launcher-source');
    const release = await fixture(resolve(root, 'release'));
    const bin = await fakeNpm(root);
    const target = resolve(root, 'managed/video-grabber');
    const installed = installSource(sourceA, target, bin);
    assert.equal(installed.status, 0, installed.stderr);
    await rm(resolve(target, 'source-roots.txt'));
    await writeFile(resolve(target, 'source-root.txt'), `${sourceA}\n`);
    const upgraded = run(release, 'install', target);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.equal(await readFile(resolve(target, 'source-roots.txt'), 'utf8'), `${sourceA}\n`);
    assert.equal(await exists(resolve(target, 'source-root.txt')), false);
    // Also exercise direct removal from an old single-entry installation.
    await rm(resolve(target, 'source-roots.txt'));
    await writeFile(resolve(target, 'source-root.txt'), `${sourceA}\n`);
    for (const name of ['node_modules', 'dist']) {
      await mkdir(resolve(sourceB, name));
      await writeFile(resolve(sourceB, name, 'artifact'), 'generated before installer');
    }
    const removed = run(sourceB, 'uninstall', target, ['--browser-removed']);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(await exists(target), false);
    for (const source of [sourceA, sourceB]) {
      assert.equal(await exists(resolve(source, 'node_modules')), false);
      assert.equal(await exists(resolve(source, 'dist')), false);
      await assertSourcePreserved(source);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid later source history aborts all cleanup and release replacement; absent roots are skipped safely', async () => {
  const root = await temporary();
  try {
    const sourceA = await sourceFixture(root, 'source-a');
    const sourceB = await sourceFixture(root, 'source-b');
    const release = await fixture(resolve(root, 'release'));
    const bin = await fakeNpm(root);
    const target = resolve(root, 'managed/video-grabber');
    for (const source of [sourceA, sourceB]) assert.equal(installSource(source, target, bin).status, 0);
    const history = `${sourceA}\n${sourceB}\n`;
    const metadata = resolve(target, 'source-roots.txt');
    const markerB = resolve(sourceB, '.video-grabber-build-root');
    async function expectRefusal() {
      assert.notEqual(run(target, 'uninstall', target, ['--browser-removed']).status, 0);
      assert.notEqual(run(release, 'install', target).status, 0);
      assert.equal(await exists(resolve(sourceA, 'node_modules/installed')), true);
      assert.equal(await exists(resolve(sourceA, 'dist/manifest.json')), true);
      assert.equal(await exists(resolve(sourceA, '.video-grabber-build-root')), true);
      assert.equal(await exists(resolve(target, 'extension/manifest.json')), true);
      await assertSourcePreserved(sourceA);
      await assertSourcePreserved(sourceB);
    }
    await writeFile(markerB, 'foreign ownership');
    await expectRefusal();
    await writeFile(markerB, `video-grabber-build-v1\n${sourceB}\n`);
    await writeFile(metadata, '');
    await expectRefusal();
    await writeFile(metadata, `${sourceA}\n${sourceB}\r\n`);
    await expectRefusal();
    await writeFile(metadata, history);
    const outside = resolve(root, 'unrelated');
    await mkdir(outside);
    await writeFile(resolve(outside, 'keep.txt'), 'unrelated');
    await rm(resolve(sourceB, 'node_modules'), { recursive: true });
    await symlink(outside, resolve(sourceB, 'node_modules'));
    await expectRefusal();
    assert.equal(await readFile(resolve(outside, 'keep.txt'), 'utf8'), 'unrelated');
    await rm(resolve(sourceB, 'node_modules'));
    await mkdir(resolve(sourceB, 'node_modules'));
    await rm(metadata);
    await writeFile(resolve(root, 'history.txt'), history);
    await symlink(resolve(root, 'history.txt'), metadata);
    await expectRefusal();
    await rm(metadata);
    const dangling = resolve(root, 'dangling-source');
    await symlink(resolve(root, 'missing'), dangling);
    await writeFile(metadata, `${history}${dangling}\n`);
    await expectRefusal();
    await writeFile(metadata, `${history}${resolve(root, 'nonexistent-checkout')}\n`);
    const removed = run(target, 'uninstall', target, ['--browser-removed']);
    assert.equal(removed.status, 0, removed.stderr);
    for (const source of [sourceA, sourceB]) {
      assert.equal(await exists(resolve(source, 'node_modules')), false);
      assert.equal(await exists(resolve(source, 'dist')), false);
      await assertSourcePreserved(source);
    }
    assert.equal(await readFile(resolve(outside, 'keep.txt'), 'utf8'), 'unrelated');
    assert.equal(await exists(target), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real npm ci, build and nested npm keep all cache and logs inside the installation', async () => {
  const root = await temporary();
  try {
    const source = await realNpmSource(root, 'source');
    const env = await isolatedNpmEnvironment(root);
    const target = resolve(root, 'managed/video-grabber');
    const installed = installWithNpm(source, target, env);
    assert.equal(installed.status, 0, installed.stderr);
    const settings = JSON.parse(await readFile(resolve(target, 'extension/npm-settings.json'), 'utf8'));
    assert.match(settings.cache, /\.video-grabber-stage\.[^/]+\/cache\/npm$/);
    assert.equal(dirname(dirname(dirname(settings.cache))), dirname(target));
    assert.equal(settings.logs, `${settings.cache}/_logs`);
    assert.equal(settings.nestedCache, settings.cache);
    assert.equal(settings.nestedLogs, settings.logs);
    const logRoot = resolve(target, 'cache/npm/_logs');
    const logs = (await Promise.all((await readdir(logRoot)).map(name => readFile(resolve(logRoot, name), 'utf8')))).join('\n');
    assert.match(logs, /title npm ci/);
    assert.match(logs, /title npm run build/);
    assert.match(logs, /title npm config get cache/);
    await assertExternalNpmUntouched(root);
    const removed = run(target, 'uninstall', target, ['--browser-removed']);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(await exists(target), false);
    await assertSourceCleaned(source);
    await assertExternalNpmUntouched(root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('two real npm installations of one checkout can both uninstall and re-import already-cleaned history', async () => {
  const root = await temporary();
  try {
    const source = await realNpmSource(root, 'source');
    const release = await fixture(resolve(root, 'release'));
    const env = await isolatedNpmEnvironment(root);
    const targetA = resolve(root, 'a/video-grabber');
    const targetB = resolve(root, 'b/video-grabber');
    for (const target of [targetA, targetB]) {
      const installed = installWithNpm(source, target, env);
      assert.equal(installed.status, 0, installed.stderr);
    }
    for (const target of [targetA, targetB]) {
      const removed = run(target, 'uninstall', target, ['--browser-removed']);
      assert.equal(removed.status, 0, removed.stderr);
      assert.equal(await exists(target), false);
      await assertSourceCleaned(source);
    }
    assert.equal(run(source, 'uninstall', targetB, ['--browser-removed']).status, 0, 'repeat cleanup from the source remains safe');

    // A second cycle leaves B's history after A removed the common outputs.
    for (const target of [targetA, targetB]) {
      const installed = installWithNpm(source, target, env);
      assert.equal(installed.status, 0, installed.stderr);
    }
    assert.equal(run(targetA, 'uninstall', targetA, ['--browser-removed']).status, 0);
    await rm(resolve(targetB, 'source-roots.txt'));
    await writeFile(resolve(targetB, 'source-root.txt'), `${source}\n`);
    const upgraded = run(release, 'install', targetB);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.equal(await readFile(resolve(targetB, 'source-roots.txt'), 'utf8'), `${source}\n`);
    assert.equal(await exists(resolve(targetB, 'source-root.txt')), false);
    const rebuilt = installWithNpm(source, targetB, env);
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    const removed = run(targetB, 'uninstall', targetB, ['--browser-removed']);
    assert.equal(removed.status, 0, removed.stderr);
    await assertSourceCleaned(source);
    await assertExternalNpmUntouched(root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('markerless history is accepted only with no remaining artifacts and rejects invalid markers before partial cleanup', async () => {
  const root = await temporary();
  try {
    const cleaned = await sourceFixture(root, 'cleaned');
    const owned = await sourceFixture(root, 'owned');
    const release = await fixture(resolve(root, 'release'));
    const bin = await fakeNpm(root);
    const target = resolve(root, 'managed/video-grabber');
    assert.equal(installSource(owned, target, bin).status, 0);
    await writeFile(resolve(target, 'source-roots.txt'), `${owned}\n${cleaned}\n`);
    async function expectRefusal() {
      assert.notEqual(run(target, 'uninstall', target, ['--browser-removed']).status, 0);
      assert.notEqual(run(release, 'install', target).status, 0);
      assert.equal(await exists(resolve(owned, 'node_modules/installed')), true);
      assert.equal(await exists(resolve(owned, '.video-grabber-build-root')), true);
      assert.equal(await exists(resolve(target, 'extension/manifest.json')), true);
      await assertSourcePreserved(cleaned);
      await assertSourcePreserved(owned);
    }
    for (const artifact of sourceArtifacts.filter(name => name !== '.video-grabber-build-root')) {
      const path = resolve(cleaned, artifact);
      await mkdir(path, { recursive: true });
      await writeFile(resolve(path, 'unowned.txt'), 'must be preserved');
      await expectRefusal();
      assert.equal(await readFile(resolve(path, 'unowned.txt'), 'utf8'), 'must be preserved');
      await rm(path, { recursive: true });
      await symlink(resolve(root, 'missing'), path);
      await expectRefusal();
      await rm(path);
    }
    const marker = resolve(cleaned, '.video-grabber-build-root');
    for (const text of ['', 'foreign marker']) {
      await writeFile(marker, text);
      await expectRefusal();
      assert.equal(await readFile(marker, 'utf8'), text);
      await rm(marker);
    }
    await mkdir(marker);
    await expectRefusal();
    await rm(marker, { recursive: true });
    await symlink(resolve(root, 'missing'), marker);
    await expectRefusal();
    await rm(marker);
    const removed = run(target, 'uninstall', target, ['--browser-removed']);
    assert.equal(removed.status, 0, removed.stderr);
    await assertSourceCleaned(cleaned);
    await assertSourceCleaned(owned);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed real npm updates retain cleanup provenance and first-install failures can clean through their source launcher', async () => {
  const root = await temporary();
  try {
    const sourceA = await realNpmSource(root, 'source-a');
    const sourceB = await realNpmSource(root, 'source-b');
    const env = await isolatedNpmEnvironment(root);
    const target = resolve(root, 'managed/video-grabber');
    const installed = installWithNpm(sourceA, target, env);
    assert.equal(installed.status, 0, installed.stderr);
    const originalManifest = await readFile(resolve(target, 'extension/manifest.json'), 'utf8');
    await writeFile(resolve(sourceB, 'public/manifest.json'), '{"name":"Video Grabber","version":"9.9.9"}');
    const failed = installWithNpm(sourceB, target, { ...env, VIDEO_GRABBER_TEST_FAIL_BUILD: '1' });
    assert.notEqual(failed.status, 0);
    assert.equal(await readFile(resolve(target, 'extension/manifest.json'), 'utf8'), originalManifest);
    assert.equal(await readFile(resolve(target, 'source-roots.txt'), 'utf8'), `${sourceA}\n${sourceB}\n`);
    assert.equal(await exists(resolve(sourceB, 'node_modules/generated')), true);
    assert.equal(await exists(resolve(sourceB, 'dist/manifest.json')), true);
    assert.deepEqual(await readdir(dirname(target)), ['video-grabber'], 'failed staging cache and logs are removed');
    assert.equal(run(target, 'uninstall', target, ['--browser-removed']).status, 0);
    await assertSourceCleaned(sourceA);
    await assertSourceCleaned(sourceB);

    const firstTarget = resolve(root, 'first/video-grabber');
    const firstFailed = installWithNpm(sourceB, firstTarget, { ...env, VIDEO_GRABBER_TEST_FAIL_BUILD: '1' });
    assert.notEqual(firstFailed.status, 0);
    assert.equal(await exists(firstTarget), false);
    assert.deepEqual(await readdir(dirname(firstTarget)), [], 'first failed staging cache and logs are removed');
    assert.equal(await exists(resolve(sourceB, '.video-grabber-build-root')), true);
    const removed = run(sourceB, 'uninstall', firstTarget, ['--browser-removed']);
    assert.equal(removed.status, 0, removed.stderr);
    await assertSourceCleaned(sourceB);
    await assertExternalNpmUntouched(root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('nested managed installations are refused before npm and historical nesting must be removed from the inside', async () => {
  const root = await temporary();
  try {
    const sourceA = await sourceFixture(root, 'source-a');
    const sourceB = await sourceFixture(root, 'source-b');
    const release = await fixture(resolve(root, 'release'));
    const bin = await fakeNpm(root);
    const outer = resolve(root, 'outer/video-grabber');
    assert.equal(installSource(sourceA, outer, bin).status, 0);
    const inner = resolve(outer, 'child/video-grabber');
    const nested = installSource(sourceB, inner, bin);
    assert.notEqual(nested.status, 0);
    assert.match(nested.stderr, /다른 관리 설치 폴더 안/);
    assert.notEqual(run(release, 'install', inner).status, 0);
    assert.equal(await exists(resolve(outer, 'child')), false);
    assert.equal(await exists(resolve(sourceB, 'npm-invocations.txt')), false);
    assert.equal(await exists(resolve(sourceB, '.video-grabber-build-root')), false);

    // Simulate a nested installation made by an older installer.
    const separate = resolve(root, 'separate/video-grabber');
    assert.equal(installSource(sourceB, separate, bin).status, 0);
    await mkdir(dirname(inner), { recursive: true });
    await cp(separate, inner, { recursive: true });
    await rm(separate, { recursive: true });
    for (const result of [run(release, 'install', outer), run(outer, 'uninstall', outer, ['--browser-removed'])]) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /안쪽 설치를 먼저 제거/);
    }
    for (const source of [sourceA, sourceB]) assert.equal(await exists(resolve(source, 'node_modules/installed')), true);
    assert.equal(await exists(resolve(inner, 'extension/manifest.json')), true);
    assert.equal(await exists(resolve(outer, 'extension/manifest.json')), true);
    assert.equal(run(inner, 'uninstall', inner, ['--browser-removed']).status, 0);
    await assertSourceCleaned(sourceB);
    assert.equal(run(outer, 'uninstall', outer, ['--browser-removed']).status, 0);
    await assertSourceCleaned(sourceA);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installations cannot hide in another owned source and historical nested payloads block source cleanup', async () => {
  const root = await temporary();
  try {
    const sourceA = await sourceFixture(root, 'source-a');
    const sourceB = await sourceFixture(root, 'source-b');
    const release = await fixture(resolve(root, 'release'));
    const bin = await fakeNpm(root);
    const targetA = resolve(root, 'a/video-grabber');
    assert.equal(installSource(sourceA, targetA, bin).status, 0);
    const nested = resolve(sourceA, 'node_modules/child/video-grabber');
    for (const result of [installSource(sourceB, nested, bin), run(release, 'install', nested)]) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /소유 표시가 있는 소스 체크아웃 밖/);
    }
    assert.equal(await exists(resolve(sourceA, 'node_modules/child')), false);
    assert.equal(await exists(resolve(sourceB, 'npm-invocations.txt')), false);
    assert.equal(await exists(resolve(sourceB, '.video-grabber-build-root')), false);

    const targetB = resolve(root, 'b/video-grabber');
    assert.equal(installSource(sourceB, targetB, bin).status, 0);
    await mkdir(dirname(nested), { recursive: true });
    await cp(targetB, nested, { recursive: true });
    await rm(targetB, { recursive: true });
    const invocationsA = await readFile(resolve(sourceA, 'npm-invocations.txt'), 'utf8');
    for (const result of [installSource(sourceA, targetA, bin), run(targetA, 'uninstall', targetA, ['--browser-removed'])]) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /안쪽 설치를 먼저 제거/);
    }
    assert.equal(await readFile(resolve(sourceA, 'npm-invocations.txt'), 'utf8'), invocationsA, 'build must not start before validation');
    for (const source of [sourceA, sourceB]) {
      assert.equal(await exists(resolve(source, 'node_modules/installed')), true);
      assert.equal(await exists(resolve(source, '.video-grabber-build-root')), true);
    }
    assert.equal(await exists(resolve(nested, 'extension/manifest.json')), true);
    assert.equal(await exists(resolve(targetA, 'extension/manifest.json')), true);
    assert.equal(run(nested, 'uninstall', nested, ['--browser-removed']).status, 0);
    await assertSourceCleaned(sourceB);
    assert.equal(run(targetA, 'uninstall', targetA, ['--browser-removed']).status, 0);
    await assertSourceCleaned(sourceA);
  } finally { await rm(root, { recursive: true, force: true }); }
});
