import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { prepareResponses, responseObject, startResponseStream } from '../src/responses.js';
import { modelCatalog, mergeCodexConfig } from '../src/codex-config.js';

const models = [{ id: 'opencode/test-free', name: 'Test', context: 200000, reasoning: true, variants: {}, images: true }];
const patch = { type: 'custom', name: 'apply_patch', description: 'Patch files', format: { type: 'text' } };
const read = { type: 'function', name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const body = extra => ({ model: models[0].id, input: 'hello', ...extra });
const result = message => ({ model: models[0].id, choices: [{ message, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, completion_tokens_details: { reasoning_tokens: 3 } } });

test('Responses input preserves instructions, images, tool identities and ordered tool results', () => {
  const adapted = prepareResponses(body({ instructions: 'Follow project rules', tools: [read, patch], reasoning: { effort: 'xhigh' }, input: [
    { role: 'user', content: [{ type: 'input_text', text: 'Inspect this' }, { type: 'input_image', image_url: 'data:image/png;base64,YQ==' }] },
    { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"x"}' },
    { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'File content' }] },
    { type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' },
    { type: 'custom_tool_call_output', call_id: 'c2', output: 'Success' },
  ] }), models);
  const messages = JSON.parse(adapted.request.text);
  assert.equal(messages[0].content, 'Follow project rules');
  assert.equal(adapted.request.images.length, 1);
  assert.equal(messages[2].tool_calls[0].id, 'c1');
  assert.equal(messages[3].tool_call_id, 'c1');
  assert.equal(messages[4].tool_calls[0].function.arguments, '{"input":"*** Begin Patch\\n*** End Patch"}');
  assert.match(adapted.request.system, /Codex alone executes actions/);
  assert.equal(adapted.definitions.get('apply_patch').type, 'custom');
});

test('Responses namespaces and custom tools round-trip without turning apply_patch into a function', () => {
  const { definitions, request } = prepareResponses(body({ tools: [{ type: 'namespace', name: 'functions', tools: [read, patch] }] }), models);
  assert.deepEqual(request.tools.map(t => t.function.name), ['functions.read_file', 'functions.apply_patch']);
  const response = responseObject(result({ content: 'Editing', tool_calls: [
    { id: 'c1', function: { name: 'functions.read_file', arguments: '{"path":"x"}' } },
    { id: 'c2', function: { name: 'functions.apply_patch', arguments: '{"input":"*** Begin Patch\\n*** End Patch"}' } },
  ] }), definitions);
  assert.equal(response.output[1].type, 'function_call');
  assert.equal(response.output[1].namespace, 'functions');
  assert.equal(response.output[2].type, 'custom_tool_call');
  assert.equal(response.output[2].name, 'apply_patch');
  assert.equal(response.output[2].input, '*** Begin Patch\n*** End Patch');
  assert.equal(response.output[2].call_id, 'c2');
  assert.equal(response.usage.output_tokens_details.reasoning_tokens, 3);
});

test('Responses rejects unsupported features and malformed custom tool arguments explicitly', () => {
  for (const bad of [body({ previous_response_id: 'resp1' }), body({ background: true }), body({ tools: [{ type: 'web_search' }] }),
    body({ input: [{ type: 'compaction', encrypted_content: 'secret' }] }), body({ text: { format: { type: 'json_schema' } } }),
    body({ input: [{ role: 'user', content: [{ type: 'input_file', file_url: 'file:///x' }] }] }), body({ stream: 'yes' })])
    assert.throws(() => prepareResponses(bad, models));
  const { definitions } = prepareResponses(body({ tools: [patch] }), models);
  assert.throws(() => responseObject(result({ tool_calls: [{ id: 'c1', function: { name: 'apply_patch', arguments: '{"input":42}' } }] }), definitions), /string input/);
});

function events(text) { return text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))); }
test('Responses SSE has stable identity, monotonic sequences and completed tool events', () => {
  let text = '';
  const stream = startResponseStream({ write: chunk => { text += chunk; }, end: () => {} }, models[0].id);
  const { definitions } = prepareResponses(body({ tools: [read, patch] }), models);
  stream.complete(result({ content: 'Done', tool_calls: [
    { id: 'c1', function: { name: 'read_file', arguments: '{"path":"x"}' } },
    { id: 'c2', function: { name: 'apply_patch', arguments: '{"input":"raw patch"}' } },
  ] }), definitions);
  const parsed = events(text);
  assert.equal(parsed[0].type, 'response.created');
  assert.equal(parsed.at(-1).type, 'response.completed');
  assert.equal(parsed[0].response.id, parsed.at(-1).response.id);
  assert.deepEqual(parsed.map(event => event.sequence_number), parsed.map((_, i) => i));
  assert.ok(parsed.some(event => event.type === 'response.function_call_arguments.done'));
  assert.ok(parsed.some(event => event.type === 'response.custom_tool_call_input.done'));
  assert.doesNotMatch(text, /\[DONE\]/);
});

test('Responses SSE failures terminate with response.failed', () => {
  let text = '';
  const stream = startResponseStream({ write: chunk => { text += chunk; }, end: () => {} }, models[0].id);
  stream.fail({ code: 'upstream_error', message: 'Unavailable' });
  assert.equal(events(text).at(-1).response.error.message, 'Unavailable');
  assert.equal(events(text).at(-1).type, 'response.failed');
});

test('Codex config preserves other providers, remains idempotent and advertises direct tools', () => {
  const original = '# User config\nmodel = "old"\nmodel_provider = "old_provider"\nmodel_catalog_json = "old.json"\n[model_providers.old_provider]\nbase_url = "http://localhost:1"\n[mcp_servers.test]\ncommand = "test"\n';
  const settings = { endpoint: 'http://127.0.0.1:41981/v1', key: 'local-only', model: models[0].id, catalog: 'C:\\path with space\\models.json' };
  const merged = mergeCodexConfig(original, settings);
  assert.match(merged, /model_provider = "oc_ferry"/);
  assert.ok(merged.includes('[model_providers.old_provider]\nbase_url = "http://localhost:1"\n[mcp_servers.test]\ncommand = "test"'));
  assert.equal(mergeCodexConfig(merged, settings), merged);
  assert.throws(() => mergeCodexConfig('[model_providers.oc_ferry]\nname="Existing"', settings), /unmanaged/);
  const catalog = modelCatalog([...models, { ...models[0], id: 'chat', chatOnly: true }]);
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0].tool_mode, 'direct');
});

test('Codex catalog accepts a preferred reasoning level only when model supports it', () => {
  const variantModel = { ...models[0], variants: { quick: { reasoningEffort: 'low' }, deep: { reasoningEffort: 'high' } } };
  const preferred = modelCatalog([variantModel], 'high').models[0];
  assert.equal(preferred.default_reasoning_level, 'high');
  assert.equal(modelCatalog([variantModel], 'max').models[0].default_reasoning_level, 'low');
  assert.equal(modelCatalog([models[0]], 'high').models[0].default_reasoning_level, 'none');
});

test('HTTP Responses endpoint supports real multi-turn tool history, auth, SSE and upstream failures', async () => {
  const observed = [];
  const server = createServer({ key: 'test', getModels: () => models,
    backend: { complete: async request => {
      observed.push(request);
      const history = JSON.parse(request.text);
      if (history.some(m => m.content === 'fail')) throw new Error('Upstream failed');
      if (history.some(m => m.role === 'tool')) return result({ content: 'Token received' });
      return result({ content: '', tool_calls: [{ id: 'read1', type: 'function', function: { name: 'read_file', arguments: '{"path":"token.txt"}' } }] });
    } }, status: () => ({ phase: 'ready' }),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/responses`;
  const send = data => fetch(url, { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    const first = await (await send(body({ tools: [read] }))).json();
    assert.equal(first.output[0].type, 'function_call');
    const second = await send(body({ stream: true, tools: [read], input: [
      { role: 'user', content: 'Read token' }, ...first.output,
      { type: 'function_call_output', call_id: 'read1', output: 'secret-token' },
    ] }));
    assert.equal(second.headers.get('content-type'), 'text/event-stream');
    assert.equal(events(await second.text()).at(-1).response.output[0].content[0].text, 'Token received');
    assert.equal(observed.length, 2);
    const failed = await send(body({ stream: true, tools: [read], input: 'fail' }));
    assert.equal(events(await failed.text()).at(-1).type, 'response.failed');
    assert.equal((await send(body({ tools: [{ type: 'web_search' }] }))).status, 400);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
