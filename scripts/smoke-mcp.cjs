// Read-only fixture used by smoke-codex.mjs. No project or user files are exposed.
const fs = require('node:fs');
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: 'ferry-smoke-fixture', version: '1.0.0' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'read_smoke_token',
    description: 'Read the token required by this smoke test.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
  else if (request.method === 'tools/call' && request.params?.name === 'read_smoke_token')
    result = { content: [{ type: 'text', text: fs.readFileSync(process.argv[2], 'utf8').trim() }] };
  else if (request.method === 'ping') result = {};
  else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
