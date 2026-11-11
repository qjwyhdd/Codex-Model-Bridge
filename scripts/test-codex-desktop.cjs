// Native Electron acceptance test. A local fixture replaces upstream inference;
// the actual main process, preload, renderer and config installer run unchanged.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

let server;
const directory = require('node:fs').mkdtempSync(path.resolve(__dirname, '../release/ferry-desktop-test-'));
process.env.FERRY_DATA_DIR = path.join(directory, 'data');
process.env.CODEX_HOME = path.join(directory, 'codex');
require('node:fs').mkdirSync(path.join(directory, 'profile'));
app.setPath('userData', path.join(directory, 'profile'));
const screenshotDir = path.resolve(__dirname, '../docs/codex-desktop');
async function waitFor(check, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function main() {
  process.env.FERRY_DATA_DIR = path.join(directory, 'data');
  process.env.CODEX_HOME = path.join(directory, 'codex');
  await fs.mkdir(process.env.FERRY_DATA_DIR); await fs.mkdir(process.env.CODEX_HOME);
  await fs.writeFile(path.join(process.env.FERRY_DATA_DIR, 'api-key'), 'fixture-key');
  const configFile = path.join(process.env.CODEX_HOME, 'config.toml');
  const original = 'model = "original-model"\nmodel_provider = "original-provider"\nweb_search = "live"\n[mcp_servers.keep]\ncommand = "keep"\n';
  await fs.writeFile(configFile, original);
  let fixture = { pid: process.pid, phase: 'ready', message: '运行中', useSystemProxy: false,
    models: [{ id: 'opencode/minimax-m3.1-flash-free', name: 'MiniMax M3.1 Flash Free', context: 200000, images: false },
      { id: 'opencode/beam-free', name: 'Beam Free', context: 1048576, images: true },
      { id: 'opencode/unavailable', name: 'Unavailable Model' }],
    availableModels: ['opencode/minimax-m3.1-flash-free', 'opencode/beam-free'],
    modelResults: { 'opencode/minimax-m3.1-flash-free': { ok: true }, 'opencode/beam-free': { ok: true },
      'opencode/unavailable': { ok: false, category: 'timeout', error: '模型暂时没有响应，请稍后再试。' } },
    probe: { running: false }, opencodeVersion: 'fixture' };
  server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer fixture-key') { res.writeHead(401); res.end('{}'); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') res.end(JSON.stringify(fixture));
    else if (req.url === '/v1/responses') res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'FERRY_OK' }] }] }));
    else res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.FERRY_PORT = String(server.address().port);
  require('../desktop/codex-main.cjs');
  await app.whenReady();
  let window;
  await waitFor(async () => { window = BrowserWindow.getAllWindows()[0]; return window && !window.webContents.isLoading() && await window.webContents.executeJavaScript('!!window.codexFerry'); }, 'panel loaded');
  const errors = [];
  window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
  const read = expression => window.webContents.executeJavaScript(expression);
  const click = id => read(`document.getElementById(${JSON.stringify(id)}).click()`);
  await waitFor(() => read('!document.getElementById("connect").disabled'), 'model ready');
  assert.equal(await read('document.getElementById("model-select").options.length'), 2);
  assert.equal(await read('typeof window.require'), 'undefined');
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
  await fs.mkdir(screenshotDir, { recursive: true });
  async function screenshot(name) {
    await delay(150);
    await fs.writeFile(path.join(screenshotDir, name + '.png'), (await window.webContents.capturePage()).toPNG());
  }
  await screenshot('01-ready');
  await click('connect');
  await waitFor(() => read('!document.getElementById("attached").hidden && !document.getElementById("restore").disabled'), 'connected');
  assert.match(await fs.readFile(configFile, 'utf8'), /model_provider = "oc_ferry"/);
  assert.match(await fs.readFile(configFile, 'utf8'), /mcp_servers.keep/);
  await screenshot('02-connected');
  await read('document.getElementById("model-select").value = "opencode/beam-free"; document.getElementById("model-select").dispatchEvent(new Event("change"))');
  await waitFor(() => read('document.getElementById("connect").textContent.includes("切换") && !document.getElementById("connect").disabled'), 'selection saved');
  await click('connect');
  await waitFor(async () => /model = "opencode\/beam-free"/.test(await fs.readFile(configFile, 'utf8')), 'model switched');
  await waitFor(() => read('!document.getElementById("test").disabled'), 'installer idle');
  await click('test');
  await waitFor(() => read('document.getElementById("feedback").textContent.includes("连接正常")'), 'connection test');
  assert.equal((await read('window.codexFerry.action("arbitrary-command", "anything")')).ok, false);
  await fs.appendFile(configFile, '\n[mcp_servers.new]\ncommand="new"\n');
  await click('restore');
  await waitFor(() => read('document.getElementById("feedback").textContent.includes("已恢复原配置")'), 'restore');
  const restored = await fs.readFile(configFile, 'utf8');
  assert.match(restored, /model = "original-model"/);
  assert.match(restored, /mcp_servers.new/);
  assert.doesNotMatch(restored, /model_providers.oc_ferry/);
  fixture = { ...fixture, phase: 'error', message: '无法连接模型服务，请检查网络后重试。', availableModels: [] };
  await waitFor(() => read('document.getElementById("service-pill").classList.contains("error")'), 'error state');
  assert.equal(await read('document.getElementById("connect").disabled'), true);
  assert.equal(await read('document.getElementById("restart").hidden'), false);
  await screenshot('03-network-error');
  fixture = { ...fixture, phase: 'ready', availableModels: ['opencode/beam-free'], probe: { running: true, pending: ['opencode/unavailable'] } };
  await waitFor(() => read('!document.getElementById("connect").disabled'), 'partial availability');
  assert.equal(await read('document.getElementById("probe").disabled'), true);
  await screenshot('04-checking');
  await read('document.getElementById("advanced").open = true');
  window.setSize(1000, 1120);
  await screenshot('05-details');
  window.close(); await delay(150); assert.equal(window.isVisible(), false);
  window.show();
  assert.deepEqual(errors, []);
  const result = { passed: true, assertions: ['ready', 'isolated renderer', 'connect', 'switch model', 'test connection', 'unknown action rejected',
    'restore preserves user edits', 'network error', 'partial availability', 'close to tray'], screenshots: screenshotDir, fixture: true };
  await fs.writeFile(path.join(screenshotDir, 'acceptance.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
main().then(() => { server?.close(); app.quit(); }).catch(async error => {
  await fs.mkdir(screenshotDir, { recursive: true });
  await fs.writeFile(path.join(screenshotDir, 'failure.txt'), error.stack);
  console.error(error.stack); process.exitCode = 1; server?.close(); app.exit(1);
});
