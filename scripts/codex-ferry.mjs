import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { dataDirectory } from '../src/platform.js';
import { modelCatalog, mergeCodexConfig, providerConfig, tomlString } from '../src/codex-config.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.FERRY_DATA_DIR || `${dataDirectory()} Codex`;
const port = Number(process.env.FERRY_PORT || 41981);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid FERRY_PORT');
const endpoint = `http://127.0.0.1:${port}/v1`;
const configHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const configFile = path.join(configHome, 'config.toml');
const receiptFile = path.join(dataDir, 'codex-install.json');
const digest = text => createHash('sha256').update(text).digest('hex');
const [command = 'run', ...args] = process.argv.slice(2);
await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });

async function serviceEnv() {
  const env = { ...process.env, FERRY_DATA_DIR: dataDir, FERRY_PORT: String(port), FERRY_NO_SYNC: '1' };
  if (!env.FERRY_OPENCODE_PATH) {
    const oldRuntime = path.join(dataDirectory(), 'runtime');
    const versions = (await fs.readdir(oldRuntime).catch(() => []))
      .filter(name => /^\d+\.\d+\.\d+$/.test(name)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    if (versions.length) env.FERRY_OPENCODE_PATH = path.join(oldRuntime, versions[0], process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  }
  return env;
}

async function health() {
  const key = (await fs.readFile(path.join(dataDir, 'api-key'), 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`Local Ferry returned HTTP ${response.status}`);
  return { key, state: await response.json() };
}

async function ensureService() {
  let current = await health().catch(() => null);
  if (!current) {
    const log = openSync(path.join(dataDir, 'launcher.log'), 'a');
    const child = spawn(process.execPath, [path.join(root, 'src/main.js')], {
      env: await serviceEnv(), cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log],
    });
    closeSync(log);
    let failure;
    child.on('error', error => { failure = error; });
    child.unref();
    console.error('正在启动 Codex Model Bridge，日志：' + path.join(dataDir, 'launcher.log'));
    for (let tries = 0; tries < 180; tries++) {
      if (failure) throw failure;
      if (child.exitCode != null) throw new Error(`Ferry exited (${child.exitCode}); see launcher.log`);
      current = await health().catch(() => null);
      if (current?.state?.models?.length) break;
      await delay(1000);
    }
  }
  for (let tries = 0; tries < 180; tries++) {
    const state = current?.state;
    if (state?.availableModels?.some(model => !state.modelResults?.[model]?.chatOnly)) return current;
    if (state?.phase === 'error') throw new Error(state.message);
    if (state?.probe && !state.probe.running && state.phase === 'ready') break;
    await delay(1000);
    current = await health();
  }
  throw new Error('No tool-capable free model is ready; see status.json and opencode.log');
}

async function generate() {
  const { state, key } = await ensureService();
  const available = state.models.filter(model => state.availableModels.includes(model.id))
    .map(model => ({ ...model, chatOnly: state.modelResults[model.id]?.chatOnly }));
  const usable = available.filter(model => !model.chatOnly);
  const requested = process.env.FERRY_CODEX_MODEL;
  const preferred = ['opencode/minimax-m3.1-flash-free', 'opencode/big-pickle', 'opencode/beam-free'];
  const model = usable.find(m => m.id === requested) ?? (!requested && (preferred.map(id => usable.find(m => m.id === id)).find(Boolean) ?? usable[0]));
  if (!model) throw new Error(`Requested model is unavailable: ${requested}`);
  const catalog = path.join(dataDir, 'codex-models.json');
  const example = path.join(dataDir, 'codex.config.toml');
  await fs.writeFile(catalog, JSON.stringify(modelCatalog(available), null, 2) + '\n', { mode: 0o600 });
  const settings = { endpoint, key, model: model.id, catalog };
  await fs.writeFile(example, mergeCodexConfig('', settings), { mode: 0o600 });
  return { settings, example, usable };
}

try {
  if (command === 'serve') {
    const child = spawn(process.execPath, [path.join(root, 'src/main.js')], { env: await serviceEnv(), cwd: root, windowsHide: true, stdio: 'inherit' });
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('exit', code => { process.exitCode = code ?? 1; });
  } else if (command === 'restore') {
    const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
    if (receipt.configFile !== configFile) throw new Error('CODEX_HOME differs from installation');
    const current = await fs.readFile(configFile, 'utf8');
    if (digest(current) !== receipt.installedHash) throw new Error(`Config changed after installation; restore manually from ${receipt.backup}`);
    await fs.copyFile(receipt.backup, configFile);
    await fs.unlink(receiptFile);
    console.log('已还原 Codex 配置：' + configFile);
  } else if (['run', 'config', 'install', 'models'].includes(command)) {
    const { settings, example, usable } = await generate();
    if (command === 'models') console.log(usable.map(model => `${model.id}\t${model.name}`).join('\n'));
    else if (command === 'config') console.log('Codex 配置：' + example + '\n模型目录：' + settings.catalog);
    else if (command === 'install') {
      await fs.mkdir(configHome, { recursive: true });
      const original = await fs.readFile(configFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      const installed = mergeCodexConfig(original, settings);
      const oldReceipt = await fs.readFile(receiptFile, 'utf8').then(JSON.parse).catch(() => null);
      if (oldReceipt && digest(original) !== oldReceipt.installedHash)
        throw new Error('Config changed since installation; restore or resolve codex-install.json first');
      const backup = oldReceipt?.backup ?? path.join(dataDir, `codex.config.backup-${Date.now()}.toml`);
      if (!oldReceipt) await fs.writeFile(backup, original, { flag: 'wx', mode: 0o600 });
      const receipt = { configFile, backup, installedHash: digest(installed) };
      const temp = `${configFile}.oc-ferry-${process.pid}.tmp`;
      await fs.writeFile(temp, installed, { mode: 0o600 });
      await fs.rename(temp, configFile);
      await fs.writeFile(receiptFile, JSON.stringify(receipt, null, 2), { mode: 0o600 });
      console.log('已接入 Codex：' + settings.model + '\n配置备份：' + backup + '\n请重启 Codex 桌面端，再新建对话。');
    } else {
      // Per-process overrides preserve the user's current desktop provider.
      const overrides = [
        '-c', 'model_provider="oc_ferry"', '-c', `model=${tomlString(settings.model)}`,
        '-c', `model_catalog_json=${tomlString(settings.catalog)}`,
        '-c', 'web_search="disabled"', '-c', 'model_reasoning_summary="none"',
        '-c', `model_providers.oc_ferry={name="Codex Model Bridge",base_url=${tomlString(endpoint)},wire_api="responses",env_key="OC_FERRY_API_KEY",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
      ];
      // Codex npm exposes a JS entrypoint. Spawn Node directly on Windows so
      // prompts and paths never pass through cmd.exe argument interpolation.
      let executable = process.env.FERRY_CODEX_PATH || 'codex';
      let prefix = [];
      if (process.platform === 'win32' && !process.env.FERRY_CODEX_PATH) {
        executable = process.execPath;
        prefix = [path.join(process.env.APPDATA, 'npm/node_modules/@openai/codex/bin/codex.js')];
        await fs.access(prefix[0]);
      }
      const clientArgs = ['exec', 'e', 'review'].includes(args[0])
        ? [args[0], ...overrides, ...args.slice(1)] : [...overrides, ...args];
      const child = spawn(executable, [...prefix, ...clientArgs], {
        env: { ...process.env, OC_FERRY_API_KEY: settings.key }, cwd: process.cwd(), windowsHide: true, stdio: 'inherit',
      });
      child.on('error', error => { console.error(error.message); process.exitCode = 1; });
      child.on('exit', code => { process.exitCode = code ?? 1; });
    }
  } else throw new Error('Usage: node scripts/codex-ferry.mjs [run|serve|models|config|install|restore] [Codex arguments]');
} catch (error) { console.error(error.message); process.exitCode = 1; }
