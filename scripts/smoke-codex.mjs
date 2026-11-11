import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tomlString } from '../src/codex-config.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ferry-codex-smoke-'));
const token = `FERRY_${randomBytes(12).toString('hex')}`;
await fs.writeFile(path.join(directory, 'input.txt'), token + '\n');
console.log('Smoke workspace: ' + directory);
const patchTest = process.argv.includes('--patch');
const mcpTest = process.argv.includes('--mcp');
const prompt = patchTest ? 'Use apply_patch to create output.txt in the current working directory containing exactly ' + token +
  ' followed by a newline. Do not call shell tools. If any tool fails, stop and report the error. Finally reply with only the token.'
  : mcpTest ? 'Call the read_smoke_token MCP tool once. The result contains a random token. Reply with only that token. Do not use shell tools or write files. If the tool is rejected, stop immediately and report the denial; do not retry.'
  : 'Reply with exactly FERRY_OK. Do not call tools.';
const logFile = path.join(directory, 'codex-events.jsonl');
const log = await fs.open(logFile, 'w');
const child = spawn(process.execPath, [path.join(root, 'scripts/codex-ferry.mjs'), 'run', 'exec',
  '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '--json', '-C', directory,
  '--sandbox', patchTest ? 'workspace-write' : 'read-only',
  ...(mcpTest ? ['-c', `mcp_servers.ferry_smoke={command=${tomlString(process.execPath)},args=[${tomlString(path.join(root, 'scripts/smoke-mcp.cjs'))},${tomlString(path.join(directory, 'input.txt'))}]} `] : []),
  prompt], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const writes = [];
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
  process.stdout.write(chunk);
  writes.push(log.write(chunk));
});
const timer = setTimeout(() => {
  console.error('Smoke test timed out after 120 seconds');
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}, 120000);
const exitCode = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
clearTimeout(timer);
await Promise.all(writes);
await log.close();
const output = await fs.readFile(path.join(directory, 'output.txt'), 'utf8').catch(() => null);
const events = await fs.readFile(logFile, 'utf8');
const messages = events.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const final = messages.filter(event => event.item?.type === 'agent_message').at(-1)?.item?.text;
const called = messages.some(event => event.item?.type === 'mcp_tool_call' && event.item?.tool === 'read_smoke_token');
const verified = exitCode === 0 && (patchTest ? output === token + '\n' : mcpTest ? called && final?.trim() === token : final?.trim() === 'FERRY_OK');
console.log(JSON.stringify({ exitCode, verified, directory, logFile }));
process.exitCode = verified ? 0 : 1;
