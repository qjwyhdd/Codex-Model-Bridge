import { reasoningEfforts } from './reasoning.js';

const BEGIN = '# BEGIN OC FERRY CODEX';
const END = '# END OC FERRY CODEX';
export const tomlString = value => JSON.stringify(value);

export function modelCatalog(models, preferredEffort = 'auto') {
  return { models: models.filter(model => !model.chatOnly).map((model, priority) => {
    const levels = Object.keys(reasoningEfforts(model));
    return {
      slug: model.id, display_name: `OC · ${model.name}`, description: 'Free model through local Codex Model Bridge',
      default_reasoning_level: levels.includes(preferredEffort) ? preferredEffort : levels.includes('medium') ? 'medium' : levels[0] ?? 'none',
      supported_reasoning_levels: levels.map(effort => ({ effort, description: `OpenCode ${effort}` })),
      shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority,
      availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null,
      apply_patch_tool_type: 'freeform', truncation_policy: { mode: 'tokens', limit: 10000 },
      context_window: model.context ?? 32768, effective_context_window_percent: 85,
      experimental_supported_tools: [], input_modalities: model.images ? ['text', 'image'] : ['text'],
      supports_parallel_tool_calls: true, supports_reasoning_summaries: false,
      supports_search_tool: false, node_repl_disabled: true, tool_mode: 'direct',
      base_instructions: 'You are a coding assistant running in Codex. Inspect the workspace, use the supplied tools to make requested changes, and verify the result. Follow the user and project instructions. Only claim actions confirmed by tool results. Use apply_patch to edit files when that tool is available. Do not repeat a rejected command without new evidence. Stop and report a policy denial if no authorized alternative exists.',
    };
  }) };
}

export function providerConfig(endpoint, key) {
  return `${BEGIN}\n[model_providers.oc_ferry]\nname = "Codex Model Bridge"\nbase_url = ${tomlString(endpoint)}\nwire_api = "responses"\nexperimental_bearer_token = ${tomlString(key)}\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\nstream_idle_timeout_ms = 300000\n${END}\n`;
}

// Change only managed provider and the top-level selection keys. All existing
// tables, auth settings, comments, MCP servers and other providers remain intact.
export function mergeCodexConfig(original, { endpoint, key, model, catalog }) {
  let text = original.replace(/# BEGIN OC FERRY CODEX\r?\n[\s\S]*?# END OC FERRY CODEX(?:\r?\n)?/g, '');
  if (/^\s*\[model_providers\.(?:oc_ferry|"oc_ferry"|'oc_ferry')\]\s*$/m.test(text))
    throw new Error('An unmanaged oc_ferry provider already exists');
  const table = text.search(/^\s*\[/m);
  let head = table < 0 ? text : text.slice(0, table);
  const tail = table < 0 ? '' : text.slice(table);
  for (const [name, value] of Object.entries({ model_provider: 'oc_ferry', model, model_catalog_json: catalog,
    web_search: 'disabled', model_reasoning_summary: 'none' })) {
    const expression = new RegExp(`^${name}\\s*=.*$`, 'm');
    if (expression.test(head)) head = head.replace(expression, () => `${name} = ${tomlString(value)}`);
    else head = `${name} = ${tomlString(value)}\n${head}`;
  }
  return `${head}${tail}`.trimEnd() + `\n\n${providerConfig(endpoint, key)}`;
}
