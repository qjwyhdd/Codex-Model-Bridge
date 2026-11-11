const $ = id => document.getElementById(id);
let state = { phase: 'starting', models: [], availableModels: [], modelResults: {}, codex: {} };
let pending = null, selectSignature = '', listSignature = '';
const text = (id, value) => { $(id).textContent = value; };
const busy = () => Boolean(pending || state.busy);
const available = () => (state.models || []).filter(model => state.availableModels?.includes(model.id) && !state.modelResults?.[model.id]?.chatOnly);
function feedback(message, error = false) {
  $('feedback').hidden = !message;
  text('feedback', message || '');
  $('feedback').className = `feedback${error ? ' error' : ''}`;
  $('feedback').setAttribute('role', error ? 'alert' : 'status');
}
function render() {
  const models = available();
  const count = models.length;
  const error = state.phase === 'error';
  const connected = state.codex?.connected;
  const working = busy();
  const probing = state.probe?.running;
  const total = state.models?.length || 0;
  const checked = Object.keys(state.modelResults || {}).filter(id => state.models?.some(model => model.id === id)).length;
  const finished = state.phase === 'ready' && !probing && total > 0;
  const quotaExhausted = Boolean(state.models?.length && state.models.every(item => state.modelResults?.[item.id]?.category === 'quota'));
  const model = models.find(entry => entry.id === state.selectedModel);
  const applied = connected && state.codex.selectedModel === model?.id;
  text('service-label', error ? '服务需要处理' : count ? `${count} 个免费模型可用` : probing ? '正在检测免费模型' : '正在准备模型');
  $('service-pill').className = `pill ${error ? 'error' : count ? 'ready' : 'preparing'}`;
  text('model-count', count ? `${count} 个可用` : probing ? '检测中' : '准备中');
  text('model-hint', count ? '选择默认模型，其余可用模型也会加入 Codex 列表。' : quotaExhausted ? 'OpenCode 免费额度已用尽。额度恢复后重测即可。' : error ? '准备遇到问题。可重新启动，或在高级设置中检查网络。' : '首次准备需要一点时间，软件会自动下载并检测。');
  const signature = JSON.stringify([models.map(model => [model.id, model.name]), state.selectedModel]);
  if (selectSignature !== signature) {
    selectSignature = signature;
    $('model-select').replaceChildren();
    if (!count) $('model-select').append(new Option(error ? '暂无可用模型' : '正在查找可用模型…', ''));
    for (const item of models) $('model-select').append(new Option(item.name, item.id, false, item.id === state.selectedModel));
  }
  $('model-select').disabled = !count || working;
  $('connect').disabled = !count || working || error;
  text('connect', pending === 'connect' || state.busy === 'connect' ? '正在接入…' : applied ? '重新应用配置 ↗' : connected ? '切换默认模型 ↗' : '接入 Codex ↗');
  text('model-meta', model ? [model.images ? '支持图片' : '文本模型', model.context ? `${Math.round(model.context / 1000)}K 上下文` : '', '工具调用检测通过'].filter(Boolean).join('  ·  ') : '只显示已通过工具调用检测的免费模型。');
  $('attached').hidden = !connected;
  text('attached-title', connected ? `已接入 · ${(state.models || []).find(m => m.id === state.codex.selectedModel)?.name || state.codex.selectedModel || '免费模型'}` : '已接入 Codex');
  $('preparing-note').hidden = Boolean(count && !probing && !error && !finished);
  $('preparing-note').className = `preparing-note${error ? ' error' : ''}`;
  text('preparing-text', quotaExhausted ? '检测已完成，但 OpenCode 免费额度已用尽，暂时没有可用模型。' : error ? state.message || '模型服务已停止。' : probing ? `${count ? '可先接入，' : ''}正在检测其余模型（${checked}/${total}）。` : finished ? `检测已结束：${checked}/${total} 个模型已有结果，${count} 个可用。` : state.message || '正在启动独立模型服务，请保持联网。');
  $('restart').hidden = !error;
  $('restart').disabled = working;
  $('step-prepare').className = `step ${count ? 'done' : 'active'}`;
  $('step-prepare').querySelector('.step-number').textContent = count ? '✓' : '1';
  $('step-connect').className = `step ${connected ? 'done' : count ? 'active' : ''}`;
  $('step-connect').querySelector('.step-number').textContent = connected ? '✓' : '2';
  $('step-use').className = `step ${connected ? 'active' : ''}`;
  $('test').disabled = !count || working || error;
  text('test', pending === 'test' || state.busy === 'test' ? '正在测试（最多 45 秒）…' : '测试连接');
  $('probe').disabled = working || state.phase !== 'ready' || probing;
  text('probe', probing ? '正在检测…' : '重新检测模型');
  $('restore').disabled = !state.codex?.canRestore || working;
  $('open-codex').disabled = working;
  $('refresh').disabled = working || state.phase !== 'ready' || probing;
  $('autostart').checked = state.autoStart === true;
  $('autostart').disabled = working;
  $('proxy').checked = state.useSystemProxy === true;
  $('proxy').disabled = working || probing || !['ready', 'error'].includes(state.phase);
  $('reasoning-select').value = state.reasoningEffort || 'auto';
  $('reasoning-select').disabled = working || probing || state.phase !== 'ready';
  $('open-data').disabled = working;
  $('open-backup').disabled = working || !state.codex?.backup;
  text('config-path', state.codex?.configFile || '尚未读取');
  text('endpoint', state.endpoint || '尚未启动');
  text('version', `软件 ${state.version || '—'} · OpenCode ${state.runtimeVersion || '准备中'}`);
  renderModels();
  if (state.codex?.error && !pending) feedback(state.codex.error, true);
}
function renderModels() {
  const signature = JSON.stringify([state.models?.map(model => [model.id, model.name]), state.modelResults, state.availableModels, state.probe, busy()]);
  if (signature === listSignature) return;
  listSignature = signature;
  const container = $('model-list'); container.replaceChildren();
  if (!state.models?.length) {
    const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '模型准备好后会显示在这里。'; container.append(empty); return;
  }
  const usable = new Set(available().map(model => model.id));
  const ordered = [...state.models].sort((a, b) => Number(usable.has(b.id)) - Number(usable.has(a.id)));
  for (const model of ordered) {
    const verdict = state.modelResults?.[model.id];
    const row = document.createElement('div'); row.className = 'model-row';
    const name = document.createElement('div'); name.className = 'model-name';
    const label = document.createElement('b'); label.textContent = model.name;
    const detail = document.createElement('small');
    detail.textContent = verdict?.error || model.id; detail.title = detail.textContent;
    name.append(label, detail);
    const status = document.createElement('span');
    status.className = `model-status ${usable.has(model.id) ? 'ok' : verdict?.ok === false ? 'failed' : ''}`;
    status.textContent = usable.has(model.id) ? '可用' : verdict?.chatOnly ? '仅支持对话' : verdict?.ok === false ? ({ timeout: '响应超时', rate_limit: '暂时限流', quota: '额度不足', access: '暂不可用' }[verdict.category] || '暂不可用') : '等待检测';
    const retry = document.createElement('button'); retry.className = 'text-button'; retry.textContent = '重测';
    retry.disabled = busy() || state.probe?.running || state.phase !== 'ready';
    retry.setAttribute('aria-label', `重新检测 ${model.name}`);
    retry.addEventListener('click', () => run('probe', model.id));
    row.append(name, status, retry); container.append(row);
  }
}
async function run(name, value) {
  if (busy()) return;
  pending = name; feedback(''); render();
  try {
    const result = await window.codexFerry.action(name, value);
    if (!result.ok) throw new Error(result.error);
    state = await window.codexFerry.state();
    if (result.result?.message) feedback(result.result.message);
  } catch (error) { feedback(error.message, true); }
  finally { pending = null; render(); }
}
for (const name of ['connect', 'restore', 'test', 'probe', 'restart', 'refresh', 'open-codex', 'open-data', 'open-backup'])
  $(name).addEventListener('click', () => run(name));
$('reasoning-select').addEventListener('change', () => run('reasoning-effort', $('reasoning-select').value));
$('model-select').addEventListener('change', () => run('select-model', $('model-select').value));
$('autostart').addEventListener('change', () => run('autostart', $('autostart').checked));
$('proxy').addEventListener('change', () => run('system-proxy', $('proxy').checked));
window.codexFerry.onState(next => { state = next; render(); });
window.codexFerry.onFeedback(value => feedback(value.error || value.message, Boolean(value.error)));
window.codexFerry.state().then(next => { state = next; render(); }).catch(error => feedback(error.message, true));
render();
