import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory } from '../src/platform.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const started = spawnSync(process.execPath, [path.join(root, 'scripts/codex-ferry.mjs'), 'config'], { stdio: 'inherit', windowsHide: true });
if (started.status !== 0) process.exit(started.status ?? 1);
const dataDir = process.env.FERRY_DATA_DIR || `${dataDirectory()} Codex`;
const key = (await fs.readFile(path.join(dataDir, 'api-key'), 'utf8')).trim();
const catalog = JSON.parse(await fs.readFile(path.join(dataDir, 'codex-models.json'), 'utf8'));
const model = process.env.FERRY_CODEX_MODEL || catalog.models.find(m => m.slug === 'opencode/minimax-m3.1-flash-free')?.slug || catalog.models[0].slug;
const url = `http://127.0.0.1:${process.env.FERRY_PORT || 41981}/v1/responses`;
const tools = [{ type: 'namespace', name: 'fixture', tools: [{ type: 'function', name: 'read_smoke_token',
  description: 'Read the random token from this test fixture.', parameters: { type: 'object', properties: {}, additionalProperties: false } }] }];
const input = [{ role: 'user', content: 'Call fixture.read_smoke_token exactly once. After receiving its result, reply with only the token. Do not invent the token.' }];
async function request(extra) {
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input, tools, ...extra }), signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(await response.text());
  if (!extra.stream) return response.json();
  const text = await response.text();
  const events = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  const completed = events.find(event => event.type === 'response.completed');
  if (!completed) throw new Error('Missing response.completed: ' + text.slice(-1000));
  return completed.response;
}
const first = await request({ tool_choice: { type: 'function', name: 'read_smoke_token', namespace: 'fixture' } });
const call = first.output.find(item => item.type === 'function_call');
if (!call || call.name !== 'read_smoke_token' || call.namespace !== 'fixture') throw new Error('Expected namespaced function call');
const token = `FERRY_${randomBytes(16).toString('hex')}`;
// This fixture returns only a fresh random string. Model input cannot select
// commands, file paths, network destinations or any other side effect.
input.push(...first.output, { type: 'function_call_output', call_id: call.call_id, output: token });
const second = await request({ stream: true, tool_choice: 'none' });
const text = second.output.filter(item => item.type === 'message').flatMap(item => item.content).map(part => part.text ?? '').join('').trim();
const verified = text === token;
const evidence = { checkedAt: new Date().toISOString(), model, verified, callType: call.type, namespace: call.namespace,
  callName: call.name, callId: call.call_id, token, actual: text, firstResponse: first.id, secondResponse: second.id };
await fs.writeFile(path.join(dataDir, 'live-responses-smoke.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
process.exitCode = verified ? 0 : 1;
