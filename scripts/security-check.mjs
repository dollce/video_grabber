import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { verifyVendor } from './verify-vendor.mjs';

const vendor = await verifyVendor();
const result = spawnSync('npm', ['audit', '--json', '--ignore-scripts'], { encoding: 'utf8', timeout: 90_000 });
if (result.error) throw result.error;
let audit;
try { audit = JSON.parse(result.stdout); } catch { throw new Error('npm audit did not return a valid report; security verification is incomplete.'); }
if (!audit.metadata?.vulnerabilities || audit.error) throw new Error('npm audit could not complete; security verification is incomplete.');
await mkdir('artifacts/security', { recursive: true });
await writeFile('artifacts/security/npm-audit.json', JSON.stringify({ checkedAt: new Date().toISOString(), ...audit }, null, 2) + '\n');
await writeFile('artifacts/security/vendor.json', JSON.stringify(vendor, null, 2) + '\n');
if (result.status !== 0 || audit.metadata.vulnerabilities.total !== 0) throw new Error('Known dependency advisories found. Review artifacts/security/npm-audit.json before release.');
console.log('npm audit: no published dependency advisories reported. Native component review is documented separately in SECURITY.md.');
