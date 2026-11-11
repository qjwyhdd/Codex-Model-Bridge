const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } = require('electron');
const { fork, execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

app.setName('Codex Model Bridge');
app.setAppUserModelId('local.ruic.oc-ferry-codex');
// Set the profile before Chromium startup and single-instance locking.
{
  const base = process.env.FERRY_DATA_DIR || path.join(process.env.APPDATA || app.getPath('appData'), 'OC Ferry Codex');
  const profile = path.join(base, 'desktop');
  require('node:fs').mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}
const root = path.join(__dirname, '..');
const port = Number(process.env.FERRY_PORT || 41981);
const endpoint = `http://127.0.0.1:${port}/v1`;
const page = pathToFileURL(path.join(__dirname, 'codex.html')).href;
let window, tray, service, log, timer, integration, dataDir, settings = {}, codex = {};
let busy = null, quitting = false, mayQuit = false, reading = false, ownsService = false;
let state = { phase: 'starting', message: '正在准备免费模型', models: [], availableModels: [], modelResults: {} };
let lastMenu = '', lastCatalog = '', nextIntegrationCheck = 0;
const reasoningEfforts = ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function usableModels() {
  return (state.models || []).filter(model => state.availableModels?.includes(model.id) && !state.modelResults?.[model.id]?.chatOnly);
}
function publicState() {
  const usable = usableModels();
  const preferred = ['opencode/minimax-m3.1-flash-free', 'opencode/big-pickle', 'opencode/beam-free'];
  const selected = usable.find(model => model.id === settings.selectedModel) ||
    preferred.map(id => usable.find(model => model.id === id)).find(Boolean) || usable[0];
  return { phase: state.phase, message: state.message, models: state.models, availableModels: state.availableModels,
    modelResults: state.modelResults, probe: state.probe, activity: state.activity, busy,
    selectedModel: selected?.id ?? null, codex, useSystemProxy: state.useSystemProxy === true,
    autoStart: app.getLoginItemSettings().openAtLogin, version: app.getVersion(), endpoint, dataDir,
    runtimeVersion: state.opencodeVersion, usableCount: usable.length, connectionTest: settings.connectionTest ?? null,
    reasoningEffort: settings.reasoningEffort || 'auto' };
}
function publish() {
  const snapshot = publicState();
  if (window && !window.isDestroyed()) window.webContents.send('codex-state', snapshot);
  if (!tray) return;
  const signature = JSON.stringify([snapshot.usableCount, state.phase, state.probe?.running, busy, codex.connected]);
  if (signature === lastMenu) return;
  lastMenu = signature;
  tray.setToolTip(`Codex Model Bridge · ${snapshot.usableCount} 个模型可用`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: snapshot.usableCount ? `${snapshot.usableCount} 个免费模型可用` : '正在准备模型', enabled: false },
    { label: '打开面板', click: showWindow }, { label: '打开 Codex', click: () => trayAction('open-codex') },
    { type: 'separator' }, { label: '恢复原配置', enabled: codex.canRestore && !busy, click: () => trayAction('restore') },
    { label: '退出软件', click: () => app.quit() },
  ]));
}
function showWindow() {
  if (!window || window.isDestroyed()) {
    window = new BrowserWindow({ width: 1000, height: 810, minWidth: 860, minHeight: 720,
      title: 'Codex Model Bridge', backgroundColor: '#f4f6fa', icon: path.join(__dirname, 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'codex-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('did-finish-load', publish);
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.on('close', event => { if (!mayQuit) { event.preventDefault(); window.hide(); } });
    window.loadFile(path.join(__dirname, 'codex.html'));
  }
  window.show(); window.focus();
}
async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  const { atomicWrite } = await import('../src/sync.js');
  await atomicWrite(path.join(dataDir, 'desktop-settings.json'), JSON.stringify(settings, null, 2));
}
async function api(route, body, timeout = 150000) {
  const key = (await fs.readFile(path.join(dataDir, 'api-key'), 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `请求失败（${response.status}）`);
  return result;
}
async function readState() {
  if (reading || quitting) return;
  reading = true;
  try {
    const health = await api('/health', undefined, 1800).catch(() => null);
    if (health?.pid && (!ownsService || health.pid === service?.pid)) state = health;
    else if (ownsService && service?.exitCode === null) {
      const disk = JSON.parse(await fs.readFile(path.join(dataDir, 'status.json'), 'utf8'));
      if (disk.pid === service.pid) state = disk;
    } else if (!ownsService && state.phase !== 'starting') state = { ...state, phase: 'error', message: '模型服务已停止，请点击重新启动。' };
    if (Date.now() > nextIntegrationCheck) {
      try { codex = await integration.status(); }
      catch (error) { codex = { ...codex, error: error.message }; }
      nextIntegrationCheck = Date.now() + 3000;
    }
    if (codex.connected && !busy) {
      const usable = usableModels();
      const signature = JSON.stringify([settings.reasoningEffort || 'auto', ...usable.map(model => [model.id, model.context, model.images, model.variants])]);
      if (usable.length && signature !== lastCatalog) { await integration.updateCatalog(usable, settings.reasoningEffort || 'auto'); lastCatalog = signature; }
    }
  } catch (error) { if (state.phase !== 'starting') state = { ...state, message: error.message }; }
  finally { reading = false; publish(); }
}
async function runtimeCandidate() {
  const { dataDirectory } = await import('../src/platform.js');
  const runtime = path.join(dataDirectory(), 'runtime');
  const versions = (await fs.readdir(runtime).catch(() => [])).filter(name => /^\d+\.\d+\.\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  if (versions.length) return path.join(runtime, versions[0], process.platform === 'win32' ? 'opencode.exe' : 'opencode');
}
async function startService() {
  const existing = await api('/health', undefined, 1500).catch(() => null);
  if (existing?.pid) { state = existing; ownsService = false; return; }
  const candidate = process.env.FERRY_OPENCODE_PATH || await runtimeCandidate();
  log = createWriteStream(path.join(dataDir, 'desktop-service.log'), { flags: 'a', mode: 0o600 });
  service = fork(path.join(root, 'src/main.js'), [], { execPath: process.execPath, execArgv: [],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', FERRY_DATA_DIR: dataDir, FERRY_PORT: String(port), FERRY_NO_SYNC: '1',
      ...(candidate ? { FERRY_OPENCODE_PATH: candidate } : {}) }, cwd: dataDir, windowsHide: true, silent: true });
  ownsService = true;
  service.stdout.pipe(log, { end: false }); service.stderr.pipe(log, { end: false });
  service.on('error', error => { state = { ...state, phase: 'error', message: error.message }; publish(); });
  service.on('exit', code => {
    if (!quitting) { state = { ...state, phase: 'error', message: `模型服务已停止（${code}），请点击重新启动。` }; publish(); }
  });
}
async function stopService() {
  if (ownsService && service && service.exitCode === null && service.signalCode === null) {
    const stopped = new Promise(resolve => service.once('exit', resolve));
    if (service.connected) service.send('shutdown', () => {});
    const finished = await Promise.race([stopped.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 12000))]);
    if (!finished) {
      if (process.platform === 'win32') await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(service.pid), '/T', '/F'], { windowsHide: true }, resolve));
      else service.kill('SIGKILL');
    }
  }
  log?.end(); ownsService = false;
}
async function findCodex() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex');
  const bins = (await fs.readdir(path.join(base, 'bin')).catch(() => [])).map(name => path.join(base, 'bin', name, 'codex.exe'));
  const candidates = [path.join(base, 'Codex.exe'), ...bins];
  for (const file of candidates) if ((await fs.stat(file).catch(() => null))?.isFile()) return file;
  return null;
}
async function action(name, value) {
  if (!['connect', 'restore', 'select-model', 'reasoning-effort', 'refresh', 'probe', 'restart', 'test', 'open-codex', 'open-data', 'open-backup', 'autostart', 'system-proxy'].includes(name)) throw new Error('未知操作');
  if (busy) throw new Error('请等待当前操作完成。');
  busy = name; publish();
  try {
    if (name === 'select-model') {
      if (!usableModels().some(model => model.id === value)) throw new Error('所选模型暂不可用。');
      await saveSettings({ selectedModel: value, connectionTest: null });
      return { message: '模型已选好，点击“接入 Codex”后生效。' };
    }
    if (name === 'reasoning-effort') {
      if (!reasoningEfforts.includes(value)) throw new Error('无效的思考程度。');
      await saveSettings({ reasoningEffort: value });
      lastCatalog = '';
      if (codex.connected && usableModels().length) {
        await integration.updateCatalog(usableModels(), value);
        lastCatalog = JSON.stringify([value, ...usableModels().map(model => [model.id, model.context, model.images, model.variants])]);
      }
      return { message: value === 'auto' ? '思考程度已恢复为模型默认。' : `思考程度已设为 ${value}，重开 Codex 后生效。` };
    }
    if (name === 'connect') {
      const selected = publicState().selectedModel;
      if (!selected) throw new Error('还没有可用模型，请等待检测完成或重新检测。');
      const key = (await fs.readFile(path.join(dataDir, 'api-key'), 'utf8')).trim();
      codex = await integration.install({ endpoint, key, model: selected, models: usableModels(), reasoningEffort: settings.reasoningEffort || 'auto' });
      await saveSettings({ selectedModel: selected });
      return { message: '已接入。请完全退出并重开 Codex，再新建对话。' };
    }
    if (name === 'restore') {
      codex = await integration.restore();
      return { message: '已恢复原配置。重开 Codex 后生效。' };
    }
    if (name === 'restart') {
      await stopService(); state = { phase: 'starting', message: '正在重新启动', models: [], availableModels: [], modelResults: {} };
      await startService(); return { message: '正在重新启动模型服务。' };
    }
    if (name === 'open-codex') {
      const file = await findCodex();
      if (!file) throw new Error('未找到 Codex 桌面端，请从开始菜单打开 Codex。');
      const error = await shell.openPath(file);
      if (error) throw new Error(error);
      return { message: '已打开 Codex。若刚接入模型，请完全退出后重新打开。' };
    }
    if (name === 'open-data' || name === 'open-backup') {
      if (name === 'open-backup') {
        if (!codex.backup) throw new Error('尚无配置备份。');
        shell.showItemInFolder(codex.backup);
      } else {
        const error = await shell.openPath(dataDir); if (error) throw new Error(error);
      }
      return {};
    }
    if (name === 'autostart') {
      if (typeof value !== 'boolean') throw new Error('无效的开机启动设置。');
      app.setLoginItemSettings({ openAtLogin: value, path: process.execPath, args: ['--hidden'] });
      return { message: value ? '已开启开机启动。' : '已关闭开机启动。' };
    }
    if (name === 'test') {
      const model = publicState().selectedModel;
      if (!model) throw new Error('请先等候可用模型。');
      const started = Date.now();
      try {
        const result = await api('/v1/responses', { model, input: 'Reply with exactly FERRY_OK. Do not call tools.', tools: [], stream: false }, 45000);
        const text = result.output?.filter(item => item.type === 'message').flatMap(item => item.content).map(part => part.text || '').join('').trim();
        if (text !== 'FERRY_OK') throw new Error('模型已响应，但没有按测试要求回答。可尝试其他模型。');
        await saveSettings({ connectionTest: { ok: true, model, elapsedMs: Date.now() - started, at: Date.now() } });
        return { message: `连接正常，用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒。` };
      } catch (error) {
        const message = error.name === 'TimeoutError' ? '免费模型响应超时，请稍后再试或换一个模型。' : error.message;
        await saveSettings({ connectionTest: { ok: false, model, message, at: Date.now() } });
        throw new Error(message);
      }
    }
    if (name === 'system-proxy' && typeof value !== 'boolean') throw new Error('无效的网络设置。');
    if (name === 'probe' && value != null && !state.models?.some(model => model.id === value)) throw new Error('模型不在目录中。');
    if (state.phase !== 'ready' && !(name === 'system-proxy' && state.phase === 'error')) throw new Error('服务仍在准备，请稍后再试。');
    if (state.probe?.running) throw new Error('正在检测模型，请稍后再试。');
    const result = await api(`/admin/${name}`, name === 'system-proxy' ? { enabled: value } : name === 'probe' && value ? { model: value } : {});
    return { ...result, message: name === 'refresh' ? '已更新模型目录。' : name === 'probe' ? '正在重新检测模型。' : '网络设置已更新。' };
  } finally { busy = null; await readState(); publish(); }
}
async function trayAction(name) {
  try { const result = await action(name); if (result.message) { showWindow(); window.webContents.send('codex-feedback', { message: result.message }); } }
  catch (error) { showWindow(); window.webContents.send('codex-feedback', { error: error.message }); }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (mayQuit) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true; clearInterval(timer);
    stopService().finally(() => { mayQuit = true; app.quit(); });
  });
  app.whenReady().then(async () => {
    const { dataDirectory } = await import('../src/platform.js');
    const { createCodexIntegration } = await import('../src/codex-integration.js');
    dataDir = process.env.FERRY_DATA_DIR || `${dataDirectory()} Codex`;
    app.setPath('userData', path.join(dataDir, 'desktop'));
    await fs.mkdir(dataDir, { recursive: true });
    settings = await fs.readFile(path.join(dataDir, 'desktop-settings.json'), 'utf8').then(JSON.parse).catch(() => ({}));
    integration = createCodexIntegration({ dataDir, configHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex') });
    codex = await integration.status().catch(error => ({ error: error.message }));
    ipcMain.handle('codex-action', async (event, name, value) => {
      if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) throw new Error('拒绝未知来源');
      try { return { ok: true, result: await action(name, value) }; }
      catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.handle('codex-state', event => {
      if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) throw new Error('拒绝未知来源');
      return publicState();
    });
    Menu.setApplicationMenu(null);
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));
    tray.on('click', showWindow);
    if (!process.argv.includes('--hidden')) showWindow();
    publish(); await startService(); await readState();
    timer = setInterval(readState, 1000);
  }).catch(error => { dialog.showErrorBox('Codex Model Bridge 启动失败', error.message); app.quit(); });
}
