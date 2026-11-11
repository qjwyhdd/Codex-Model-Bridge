import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const release = path.join(root, 'release');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const installer = path.join(release, `Codex-Model-Bridge-Setup-${pkg.version}-win-x64.exe`);
const app = path.join(release, 'win-unpacked', 'Codex Model Bridge.exe');
const read = async file => fs.readFile(file);
const [installerBytes, appBytes] = await Promise.all([read(installer), read(app)]);
for (const [label, bytes] of [['installer', installerBytes], ['app', appBytes]]) {
  assert.equal(bytes.subarray(0, 2).toString(), 'MZ', `${label} must be a Windows executable`);
}
const peOffset = appBytes.readUInt32LE(0x3c);
assert.equal(appBytes.subarray(peOffset, peOffset + 4).toString('hex'), '50450000', 'app must contain a valid PE header');
const appRoot = path.join(release, 'win-unpacked', 'resources', 'app');
for (const file of ['desktop/codex-main.cjs', 'desktop/codex-preload.cjs', 'desktop/codex-renderer.js',
  'desktop/codex.html', 'desktop/codex.css', 'src/codex-integration.js', 'src/responses.js'])
  await fs.access(path.join(appRoot, file));
console.log(JSON.stringify({ passed: true, installer, installerBytes: installerBytes.length,
  appBytes: appBytes.length, includedFiles: 7, executableHeaders: true }, null, 2));
