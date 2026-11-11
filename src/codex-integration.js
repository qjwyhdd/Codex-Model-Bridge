import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite } from './sync.js';
import { modelCatalog, mergeCodexConfig } from './codex-config.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const selectedKeys = ['model_provider', 'model', 'model_catalog_json', 'web_search', 'model_reasoning_summary'];
const managed = /# BEGIN OC FERRY CODEX\r?\n[\s\S]*?# END OC FERRY CODEX(?:\r?\n)?/g;
const provider = /^\s*model_provider\s*=\s*["']oc_ferry["']/m;

async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function receiptAt(file) {
  const text = await readOptional(file);
  if (text === null) return null;
  try { return JSON.parse(text); }
  catch { throw new Error('配置备份记录已损坏，请打开数据文件夹检查 codex-install.json。'); }
}

// Three-way restore: revert only fields written by this app. Preserve edits to
// unrelated MCP/providers/settings made after connection, and stop on conflicts.
export function restoreManagedConfig(current, installed, original) {
  const split = text => {
    const clean = text.replace(managed, '');
    const table = clean.search(/^\s*\[/m);
    return table < 0 ? [clean, ''] : [clean.slice(0, table), clean.slice(table)];
  };
  let [head, tail] = split(current);
  const [installedHead] = split(installed);
  const [originalHead] = split(original);
  const line = (text, key) => text.match(new RegExp(`^[ \\t]*${key}\\s*=.*$`, 'm'))?.[0];
  for (const key of selectedKeys) {
    const actual = line(head, key), expected = line(installedHead, key), previous = line(originalHead, key);
    if (actual === previous) continue;
    if (actual !== expected) throw new Error(`Codex 的 ${key} 已被其他程序修改。为保留你的修改，请先在高级设置中打开备份。`);
    const expression = new RegExp(`^[ \\t]*${key}\\s*=.*(?:\\r?\\n|$)`, 'm');
    head = head.replace(expression, previous === undefined ? '' : `${previous}\n`);
  }
  return head + tail;
}

export function createCodexIntegration({ dataDir, configHome }) {
  const file = path.join(configHome, 'config.toml');
  const receiptFile = path.join(dataDir, 'codex-install.json');
  const catalogFile = path.join(dataDir, 'codex-models.json');
  const installedFile = path.join(dataDir, 'codex-installed.toml');
  let queue = Promise.resolve();
  const serialize = task => {
    const operation = queue.then(task);
    queue = operation.catch(() => {});
    return operation;
  };
  async function status() {
    const current = await readOptional(file);
    const receipt = await receiptAt(receiptFile);
    const sameHome = !receipt || path.resolve(receipt.configFile) === path.resolve(file);
    return { configFile: file, connected: provider.test(current ?? ''), canRestore: Boolean(receipt && sameHome),
      backup: sameHome ? receipt?.backup : undefined,
      changed: Boolean(receipt && hash(current ?? '') !== receipt.installedHash),
      selectedModel: current?.match(/^\s*model\s*=\s*"([^"\r\n]+)"/m)?.[1] ?? null };
  }
  async function updateCatalog(models, reasoningEffort = 'auto') {
    const catalog = modelCatalog(models, reasoningEffort);
    await atomicWrite(catalogFile, JSON.stringify(catalog, null, 2) + '\n');
    return catalog.models.length;
  }
  async function install({ endpoint, key, model, models, reasoningEffort = 'auto' }) {
    return serialize(async () => {
      const usable = models.filter(entry => !entry.chatOnly);
      if (!usable.some(entry => entry.id === model)) throw new Error('所选模型暂不可用，请选一个可用模型。');
      const original = (await readOptional(file)) ?? '';
      const receipt = await receiptAt(receiptFile);
      if (receipt && path.resolve(receipt.configFile) !== path.resolve(file))
        throw new Error('此备份属于另一个 Codex 配置目录，请先恢复原配置。');
      if (receipt && hash(original) !== receipt.installedHash) {
        const last = await readOptional(installedFile);
        if (!last) throw new Error('接入后配置已改变，请先恢复或检查备份。');
        restoreManagedConfig(original, last, (await readOptional(receipt.backup)) ?? '');
      }
      await fs.mkdir(dataDir, { recursive: true });
      await fs.mkdir(configHome, { recursive: true });
      const existed = await readOptional(file) !== null;
      const backup = receipt?.backup ?? path.join(dataDir, `codex.config.backup-${Date.now()}.toml`);
      if (!receipt) await fs.writeFile(backup, original, { mode: 0o600, flag: 'wx' });
      await updateCatalog(usable, reasoningEffort);
      const installed = mergeCodexConfig(original, { endpoint, key, model, catalog: catalogFile });
      // Persist recovery information before touching the user's config.
      await atomicWrite(installedFile, installed);
      await atomicWrite(receiptFile, JSON.stringify({ configFile: file, backup, existed: receipt?.existed ?? existed,
        installedHash: hash(installed), model }, null, 2) + '\n');
      if (((await readOptional(file)) ?? '') !== original) throw new Error('Codex 配置正在被其他程序修改，请重试。');
      await atomicWrite(file, installed);
      return status();
    });
  }
  async function restore() {
    return serialize(async () => {
      const receipt = await receiptAt(receiptFile);
      if (!receipt) throw new Error('尚未接入，无需恢复。');
      if (path.resolve(receipt.configFile) !== path.resolve(file)) throw new Error('备份属于另一个 Codex 配置目录。');
      const current = (await readOptional(file)) ?? '';
      const original = await readOptional(receipt.backup);
      if (original === null) throw new Error('未找到配置备份，请在数据文件夹中检查。');
      let restored = original;
      if (hash(current) !== receipt.installedHash) {
        const installed = await readOptional(installedFile);
        if (!installed) throw new Error('配置已被修改，请按备份手动恢复。');
        const currentBlock = current.match(managed)?.[0];
        const installedBlock = installed.match(managed)?.[0];
        if (currentBlock && currentBlock !== installedBlock) throw new Error('OC Ferry 的配置块已被修改，请检查备份。');
        restored = restoreManagedConfig(current, installed, original);
      }
      if (((await readOptional(file)) ?? '') !== current) throw new Error('Codex 配置正在被其他程序修改，请重试。');
      if (receipt.existed === false && !restored.trim()) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      else await atomicWrite(file, restored);
      await fs.unlink(receiptFile);
      return status();
    });
  }
  return { status, install, restore, updateCatalog };
}
