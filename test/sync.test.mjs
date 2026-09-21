import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncEngine } from '../lib/sync.js';

const CATALOG = {
  openrouter: {
    known: { id: 'known', name: 'Known', api: 'openai-completions', contextWindow: 100000, input: ['text'] },
    'stealth/union-alpha': { id: 'stealth/union-alpha', name: 'Union Alpha', api: 'openai-completions', contextWindow: 262144, maxTokens: 131072, input: ['text', 'image'], compat: { thinkingFormat: 'openrouter' } },
  },
  'zai-coding-cn': {
    'glm-5.3': { id: 'glm-5.3', name: 'GLM-5.3', api: 'openai-completions', contextWindow: 200000, input: ['text'] },
  },
};

const BUILTIN = {
  openrouter: [{ id: 'known', api: 'anthropic-messages' }, { id: 'legacy', api: 'openai-completions' }],
  'zai-coding-cn': [{ id: 'glm-5.2', api: 'openai-completions' }],
};

function settingsService(initial = {}) {
  const state = { revision: 1, user: initial, calls: [] };
  return {
    state,
    describe: () => [{ ns: 'llm-pi-ai', revision: state.revision, user: state.user }],
    mutate: async (ns, ops, revision) => {
      state.calls.push({ ns, ops, revision });
      for (const op of ops) {
        const [group, route, key] = op.path;
        state.user = { ...state.user, [group]: { ...state.user[group], [route]: { ...state.user[group]?.[route], [key]: op.value } } };
      }
    },
  };
}

function engine(overrides = {}) {
  const fetches = [];
  const settings = overrides.settings ?? settingsService();
  const instance = createSyncEngine({
    settings,
    config: {
      managedRoutes: ['openrouter', 'zai-coding-cn'],
      mixedProtocolStrategy: 'companion',
      companions: [{ source: 'openrouter', route: 'openrouter-live', api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' }],
      keepBuiltinOnly: true,
      ...overrides.config,
    },
    fetchCatalog: async (options) => {
      fetches.push(options);
      if (overrides.notModified === true && fetches.length > 1) return { notModified: true, etag: 'W/"1"' };
      return { notModified: false, etag: 'W/"1"', catalog: overrides.catalog ?? CATALOG };
    },
    readBuiltin: (route) => (overrides.noBuiltin === true ? undefined : BUILTIN[route]),
    listModelIds: overrides.listModelIds,
  });
  return { instance, settings, fetches };
}

test('a single-protocol route syncs in place, companion route stays out of it', async () => {
  const { instance, settings } = engine();
  const { report } = await instance.syncNow({ dryRun: false });
  const zaiOp = settings.state.calls.find((call) => call.ops[0].path[1] === 'zai-coding-cn');
  assert.ok(zaiOp !== undefined);
  assert.deepEqual(zaiOp.ops[0].value.map((model) => model.id), ['glm-5.2', 'glm-5.3']);
  assert.match(report, /zai-coding-cn: single-protocol \(openai-completions\) → in-place/);
  assert.match(report, /pi\.dev 1 · builtin 1 · new 1 · dropped 0/);
});

test('a mixed-protocol route leaves the built-in route alone and fills the companion route', async () => {
  const { instance, settings } = engine();
  const { report } = await instance.syncNow();
  const targets = settings.state.calls.map((call) => call.ops[0].path[1]);
  assert.deepEqual(targets, ['openrouter-live', 'zai-coding-cn']);
  const companion = settings.state.calls[0];
  assert.deepEqual(companion.ops[0].value.map((model) => model.id), ['stealth/union-alpha']);
  assert.deepEqual(companion.ops.map((op) => op.path.join('.')), [
    'providers.openrouter-live.models',
    'providers.openrouter-live.api',
    'providers.openrouter-live.baseURL',
    'providers.openrouter-live.apiKeyEnv',
  ]);
  assert.equal(settings.state.user.providers.openrouter, undefined);
  assert.match(report, /openrouter: mixed-protocol \(anthropic-messages, openai-completions\) → companion/);
  assert.match(report, /companion openrouter-live \(openai-completions, https:\/\/openrouter\.ai\/api\/v1\)/);
  assert.match(report, /pi\.dev 2 · builtin 2 · new 1 · dropped 0/);
});

test('the second round reuses the cached catalog through the stored etag', async () => {
  const { instance, fetches } = engine({ notModified: true });
  await instance.syncNow();
  await instance.syncNow();
  assert.equal(fetches.length, 2);
  assert.equal(fetches[1].etag, 'W/"1"');
});

const MIXED_CATALOG = {
  openrouter: {
    known: { id: 'known', name: 'Known', api: 'anthropic-messages', contextWindow: 200000, input: ['text'] },
    'stealth/union-alpha': { id: 'stealth/union-alpha', name: 'Union Alpha', api: 'openai-completions', contextWindow: 262144, input: ['text', 'image'] },
  },
  'zai-coding-cn': CATALOG['zai-coding-cn'],
};

test('an unreadable built-in catalog infers the protocol families from pi.dev and still classifies base models', async () => {
  const { instance, settings } = engine({
    noBuiltin: true,
    catalog: MIXED_CATALOG,
    listModelIds: async (route) => (route === 'openrouter' ? ['known'] : []),
  });
  const { report } = await instance.syncNow();
  const companion = settings.state.calls.find((call) => call.ops[0].path[1] === 'openrouter-live');
  assert.ok(companion !== undefined);
  assert.deepEqual(companion.ops[0].value.map((model) => model.id), ['stealth/union-alpha']);
  assert.match(report, /openrouter: mixed-protocol \(anthropic-messages, openai-completions\) → companion/);
  assert.match(report, /builtin 1 · new 1/);
});

test('a configured route pi.dev does not serve is reported as skipped', async () => {
  const { instance } = engine({ config: { managedRoutes: ['openrouter', 'ghost-route'] } });
  const { report } = await instance.syncNow();
  assert.match(report, /not on pi\.dev \(skipped\): ghost-route/);
});

test('dry run plans every route without touching settings', async () => {
  const { instance, settings } = engine();
  const { report, results } = await instance.syncNow({ dryRun: true });
  assert.equal(settings.state.calls.length, 0);
  assert.equal(results.every((result) => result.status === 'dry-run'), true);
  assert.match(report, /dry run/);
  assert.match(report, /would write 1 models/);
});
