import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCodexIntegration } from '../src/codex-integration.js';

const models = [{ id: 'opencode/free', name: 'Free', context: 100000 }, { id: 'opencode/other', name: 'Other' }];
const settings = { endpoint: 'http://127.0.0.1:41981/v1', key: 'test-key', model: 'opencode/free', models };
async function fixture(run, original = 'model = "original"\nmodel_provider = "original"\nweb_search = "live"\n[mcp_servers.keep]\ncommand = "keep"\n') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-integration-'));
  const dataDir = path.join(directory, 'data'), configHome = path.join(directory, 'codex');
  await fs.mkdir(configHome);
  const config = path.join(configHome, 'config.toml');
  if (original !== null) await fs.writeFile(config, original);
  const integration = createCodexIntegration({ dataDir, configHome });
  try { await run({ integration, config, dataDir, configHome, original }); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}
test('Codex install backs up, switches models and restores exact original bytes', async () => fixture(async ({ integration, config, dataDir, original }) => {
  assert.equal((await integration.status()).connected, false);
  const first = await integration.install(settings);
  assert.equal(first.connected, true); assert.equal(first.canRestore, true);
  assert.equal(await fs.readFile(first.backup, 'utf8'), original);
  const second = await integration.install({ ...settings, model: 'opencode/other' });
  assert.equal(second.backup, first.backup);
  assert.equal(second.selectedModel, 'opencode/other');
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'codex-models.json'))).models.length, 2);
  await integration.restore();
  assert.equal(await fs.readFile(config, 'utf8'), original);
  assert.equal((await integration.status()).canRestore, false);
}));
test('Codex restore preserves unrelated user edits after connection', async () => fixture(async ({ integration, config }) => {
  await integration.install(settings);
  await fs.appendFile(config, '\n[mcp_servers.new]\ncommand = "new"\n');
  const status = await integration.status(); assert.equal(status.changed, true);
  await integration.restore();
  const restored = await fs.readFile(config, 'utf8');
  assert.match(restored, /model = "original"/);
  assert.match(restored, /web_search = "live"/);
  assert.ok(restored.includes('[mcp_servers.new]\ncommand = "new"'));
  assert.doesNotMatch(restored, /model_providers\.oc_ferry/);
}));
test('Codex restore refuses conflicting model edits and preserves config', async () => fixture(async ({ integration, config }) => {
  await integration.install(settings);
  const edited = (await fs.readFile(config, 'utf8')).replace('model = "opencode/free"', 'model = "user-choice"');
  await fs.writeFile(config, edited);
  await assert.rejects(integration.restore(), /model 已被其他程序修改/);
  assert.equal(await fs.readFile(config, 'utf8'), edited);
  assert.equal((await integration.status()).canRestore, true);
}));
test('Codex update after unrelated changes keeps first backup and new MCP config', async () => fixture(async ({ integration, config, original }) => {
  const first = await integration.install(settings);
  await fs.appendFile(config, '\n[mcp_servers.new]\ncommand="new"\n');
  const second = await integration.install({ ...settings, model: 'opencode/other' });
  assert.equal(first.backup, second.backup);
  assert.equal(await fs.readFile(first.backup, 'utf8'), original);
  assert.match(await fs.readFile(config, 'utf8'), /mcp_servers\.new/);
}));
test('Codex new installation removes newly created config on restore', async () => fixture(async ({ integration, config }) => {
  await integration.install(settings); await integration.restore();
  await assert.rejects(fs.access(config), { code: 'ENOENT' });
}, null));
test('Codex refuses unavailable models and another config home', async () => fixture(async ({ integration, configHome, dataDir }) => {
  await assert.rejects(integration.install({ ...settings, model: 'missing' }), /暂不可用/);
  await integration.install(settings);
  const other = createCodexIntegration({ dataDir, configHome: path.join(configHome, 'other') });
  await assert.rejects(other.install(settings), /另一个 Codex 配置目录/);
  await assert.rejects(other.restore(), /另一个 Codex 配置目录/);
}));
test('Codex rejects a corrupt receipt instead of overwriting recovery history', async () => fixture(async ({ integration, dataDir }) => {
  await fs.mkdir(dataDir); await fs.writeFile(path.join(dataDir, 'codex-install.json'), 'broken');
  await assert.rejects(integration.install(settings), /已损坏/);
}));
