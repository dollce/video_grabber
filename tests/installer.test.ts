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
