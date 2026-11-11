import { randomUUID } from 'node:crypto';
import { BridgeError, prepare } from './protocol.js';
import { reasoningEfforts } from './reasoning.js';
import { clientModelID } from './model-status.js';

const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const alias = (name, namespace) => namespace ? `${namespace}.${name}` : name;
const invalid = message => { throw new BridgeError(message); };

function content(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return invalid('Message content must be text or a content array');
  return value.map(part => {
    if (['input_text', 'output_text', 'text'].includes(part?.type) && typeof part.text === 'string')
      return { type: 'text', text: part.text };
    if (part?.type === 'input_image' && typeof part.image_url === 'string')
      return { type: 'image_url', image_url: { url: part.image_url } };
    if (part?.type === 'refusal' && typeof part.refusal === 'string')
      return { type: 'text', text: part.refusal };
    return invalid(`Unsupported Responses content: ${part?.type}`);
  });
}

// OpenCode sees ordinary JSON function schemas. Codex still receives the original
// function/custom tool type and namespace, including freeform apply_patch calls.
export function prepareResponses(body, models) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Request must be an object');
  if (body.previous_response_id != null) invalid('Send full input history; previous_response_id is not supported');
  if (body.background === true) invalid('Background Responses are not supported');
  if (body.text?.format && body.text.format.type !== 'text') invalid('Structured text output is not supported');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream must be a boolean');
  const definitions = new Map();
  const tools = [];
  function add(tool, namespace) {
    if (!tool || typeof tool !== 'object') invalid('Invalid Responses tool');
    if (tool.type === 'namespace') {
      if (namespace || typeof tool.name !== 'string' || !Array.isArray(tool.tools)) invalid('Invalid tool namespace');
      for (const nested of tool.tools) add(nested, tool.name);
      return;
    }
    if (!['function', 'custom'].includes(tool.type) || typeof tool.name !== 'string' || !tool.name)
      invalid(`Unsupported Responses tool: ${tool.type}`);
    const name = alias(tool.name, namespace);
    if (definitions.has(name)) invalid('Duplicate tool names');
    definitions.set(name, { ...tool, namespace });
    const custom = tool.type === 'custom';
    tools.push({ type: 'function', function: {
      name,
      description: [tool.description, custom ? 'Return the complete raw tool input in the input string, preserving every newline.' : '',
        custom && tool.format ? `Required input format: ${JSON.stringify(tool.format)}` : ''].filter(Boolean).join('\n'),
      parameters: custom ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false }
        : tool.parameters ?? { type: 'object', properties: {} },
    } });
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) invalid('tools must be an array');
  for (const tool of body.tools ?? []) add(tool);

  const messages = [];
  if (body.instructions != null) {
    if (typeof body.instructions !== 'string') invalid('instructions must be text');
    messages.push({ role: 'developer', content: body.instructions });
  }
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
  if (!Array.isArray(input) || !input.length) invalid('input must be text or a nonempty array');
  for (const item of input) {
    if (!item || typeof item !== 'object') invalid('Invalid input item');
    if (item.type === 'message' || (!item.type && item.role)) {
      if (!['system', 'developer', 'user', 'assistant'].includes(item.role)) invalid('Unknown message role');
      messages.push({ role: item.role, content: content(item.content) });
    } else if (['function_call', 'custom_tool_call'].includes(item.type)) {
      if (typeof item.name !== 'string' || typeof item.call_id !== 'string') invalid('Invalid historical tool call');
      const args = item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : item.arguments;
      if (typeof args !== 'string' || (item.type === 'custom_tool_call' && typeof item.input !== 'string')) invalid('Invalid historical tool arguments');
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: item.call_id, type: 'function',
        function: { name: alias(item.name, item.namespace), arguments: args } }] });
    } else if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      if (typeof item.call_id !== 'string') invalid('Tool output requires call_id');
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: content(item.output) });
    } else if (item.type === 'reasoning') {
      // Encrypted reasoning is provider-specific; visible summaries remain history.
      const summary = (item.summary ?? []).map(part => part.text ?? '').filter(Boolean).join('\n');
      if (summary) messages.push({ role: 'assistant', content: summary });
    } else invalid(`Unsupported Responses input item: ${item.type}`);
  }
  let toolChoice = body.tool_choice ?? 'auto';
  if (toolChoice && typeof toolChoice === 'object') {
    if (!['function', 'custom'].includes(toolChoice.type)) invalid(`Unsupported tool_choice: ${toolChoice.type}`);
    toolChoice = { type: 'function', function: { name: alias(toolChoice.name, toolChoice.namespace) } };
  }
  const chat = { model: body.model, messages, tools, tool_choice: toolChoice, parallel_tool_calls: body.parallel_tool_calls };
  const model = models.find(m => m.id === body.model || clientModelID(m) === body.model);
  const effort = body.reasoning?.effort;
  // Codex may send its default effort even for a model with no matching variant.
  // In that case keep the OpenCode model's default; never invent a capability.
  if (effort != null && typeof effort !== 'string') invalid('Invalid reasoning effort');
  if (model && effort && Object.hasOwn(reasoningEfforts(model), effort)) chat.reasoning_effort = effort;
  const request = prepare(chat, models);
  request.system = request.system.replaceAll('WorkBuddy', 'Codex');
  return { request, definitions };
}

export function responseObject(result, definitions, identity = {}) {
  const message = result.choices?.[0]?.message;
  if (!message) throw new BridgeError('Upstream completion is missing a message', 502, 'invalid_model_output');
  const output = [];
  if (message.content) output.push({ id: id('msg'), type: 'message', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text: message.content, annotations: [] }] });
  for (const call of message.tool_calls ?? []) {
    const definition = definitions.get(call.function.name);
    if (!definition) throw new BridgeError('Upstream returned an unknown tool', 502, 'invalid_tool_call');
    const base = { id: id(definition.type === 'custom' ? 'ctc' : 'fc'), call_id: call.id,
      name: definition.name, ...(definition.namespace ? { namespace: definition.namespace } : {}), status: 'completed' };
    if (definition.type === 'custom') {
      let args;
      try { args = JSON.parse(call.function.arguments); } catch {}
      if (typeof args?.input !== 'string') throw new BridgeError('Custom tool requires a string input', 502, 'invalid_tool_call');
      output.push({ ...base, type: 'custom_tool_call', input: args.input });
    } else output.push({ ...base, type: 'function_call', arguments: call.function.arguments });
  }
  const usage = result.usage;
  return { id: identity.id ?? id('resp'), object: 'response', created_at: identity.created_at ?? Math.floor(Date.now() / 1000),
    status: 'completed', error: null, incomplete_details: null, model: result.model, output, parallel_tool_calls: true,
    usage: usage ? { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
      input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 },
      output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 } } : null,
    store: false };
}

// Match Responses lifecycle events, not Chat Completions chunks or [DONE].
// Like the original bridge, buffer model output until its envelope is valid.
export function startResponseStream(res, model) {
  const identity = { id: id('resp'), created_at: Math.floor(Date.now() / 1000) };
  const pending = { ...identity, object: 'response', model, status: 'in_progress', output: [], error: null, usage: null };
  let sequence = 0;
  const emit = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`);
  emit('response.created', { response: pending });
  emit('response.in_progress', { response: pending });
  return {
    complete(result, definitions) {
      const response = responseObject(result, definitions, identity);
      response.output.forEach((item, output_index) => {
        const fields = { item_id: item.id, output_index };
        const initial = { ...item, status: 'in_progress' };
        if (item.type === 'message') initial.content = [];
        else if (item.type === 'custom_tool_call') initial.input = '';
        else initial.arguments = '';
        emit('response.output_item.added', { output_index, item: initial });
        if (item.type === 'message') {
          const part = item.content[0];
          emit('response.content_part.added', { ...fields, content_index: 0, part: { ...part, text: '' } });
          emit('response.output_text.delta', { ...fields, content_index: 0, delta: part.text, logprobs: [] });
          emit('response.output_text.done', { ...fields, content_index: 0, text: part.text, logprobs: [] });
          emit('response.content_part.done', { ...fields, content_index: 0, part });
        } else {
          const custom = item.type === 'custom_tool_call';
          const field = custom ? 'input' : 'arguments';
          const event = custom ? 'custom_tool_call_input' : 'function_call_arguments';
          emit(`response.${event}.delta`, { ...fields, delta: item[field] });
          emit(`response.${event}.done`, { ...fields, [field]: item[field], name: item.name });
        }
        emit('response.output_item.done', { output_index, item });
      });
      emit('response.completed', { response });
      res.end();
    },
    fail(error) {
      emit('response.failed', { response: { ...pending, status: 'failed', error } });
      res.end();
    },
  };
}
