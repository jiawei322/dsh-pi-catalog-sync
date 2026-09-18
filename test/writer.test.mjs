import test from 'node:test';
import assert from 'node:assert/strict';
import { writeRoute, requestsForPlan, overrideBlockReason, SETTINGS_CONFLICT } from '../lib/writer.js';

function settingsService(initial) {
  const state = {
    revision: 7,
    user: initial,
    calls: [],
    failWith: undefined,
  };
  return {
    state,
    describe: () => [{ ns: 'llm-pi-ai', revision: state.revision, user: state.user }],
    mutate: async (ns, ops, revision) => {
      state.calls.push({ ns, ops, revision });
      if (state.failWith !== undefined) {
        const error = state.failWith;
        state.failWith = undefined;
        state.revision += 1;
        throw error;
      }
      for (const op of ops) {
        assert.equal(op.op, 'set');
        const [group, route, key] = op.path;
        state.user = { ...state.user, [group]: { ...state.user[group], [route]: { ...state.user[group]?.[route], [key]: op.value } } };
      }
    },
  };
}

const MODELS = [{ id: 'b', contextWindow: 1000 }, { id: 'a', contextWindow: 2000 }];

test('writes the models list at the current revision', async () => {
  const settings = settingsService({});
  const result = await writeRoute({ settings, request: { route: 'zai-coding-cn', models: MODELS } });
  assert.equal(result.status, 'wrote');
  assert.equal(result.models, 2);
  assert.equal(settings.state.calls.length, 1);
  assert.equal(settings.state.calls[0].revision, 7);
  assert.deepEqual(settings.state.calls[0].ops, [{ op: 'set', path: ['providers', 'zai-coding-cn', 'models'], value: MODELS }]);
  assert.deepEqual(settings.state.user.providers['zai-coding-cn'].models, MODELS);
});

test('an identical list is a no-change round with no mutate', async () => {
  const settings = settingsService({ providers: { 'zai-coding-cn': { models: MODELS } } });
  const result = await writeRoute({ settings, request: { route: 'zai-coding-cn', models: MODELS } });
  assert.equal(result.status, 'no-change');
  assert.equal(settings.state.calls.length, 0);
});

test('a revision conflict is retried once against the fresh revision', async () => {
  const settings = settingsService({});
  const conflict = new Error('revision mismatch');
  conflict.code = SETTINGS_CONFLICT;
  settings.state.failWith = conflict;
  const result = await writeRoute({ settings, request: { route: 'zai-coding-cn', models: MODELS } });
  assert.equal(result.status, 'wrote');
  assert.equal(result.conflictRetry, true);
  assert.equal(settings.state.calls.length, 2);
  assert.equal(settings.state.calls[0].revision, 7);
  assert.equal(settings.state.calls[1].revision, 8);
});

test('a second rejection is reported, not thrown', async () => {
  const settings = settingsService({});
  settings.mutate = async (ns, ops, revision) => {
    settings.state.calls.push({ ns, ops, revision });
    const error = new Error('llm-pi-ai refused the route: api openai-completions on a mixed-protocol route');
    error.code = SETTINGS_CONFLICT;
    throw error;
  };
  const result = await writeRoute({ settings, request: { route: 'openrouter-live', models: MODELS } });
  assert.equal(result.status, 'rejected');
  assert.match(result.reason, /mixed-protocol/);
  assert.equal(result.conflictRetry, true);
  assert.equal(settings.state.calls.length, 2);
});

test('a non-conflict failure is reported without a retry', async () => {
  const settings = settingsService({});
  settings.mutate = async () => { throw new Error('llm-pi-ai refused the entry'); };
  const result = await writeRoute({ settings, request: { route: 'zai-coding-cn', models: MODELS } });
  assert.equal(result.status, 'rejected');
  assert.equal(settings.state.calls.length, 0);
});

test('a route carrying modelOverrides is skipped instead of fought with', async () => {
  const settings = settingsService({ providers: { openrouter: { modelOverrides: { 'x/y': { contextWindow: 1000 } } } } });
  const result = await writeRoute({ settings, request: { route: 'openrouter', models: MODELS } });
  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /modelOverrides/);
  assert.equal(settings.state.calls.length, 0);
  assert.ok(overrideBlockReason({ user: { providers: { openrouter: { modelOverrides: {} } } } }, 'openrouter') === undefined);
});

test('dry-run reports the ops without mutating', async () => {
  const settings = settingsService({});
  const result = await writeRoute({ settings, request: { route: 'zai-coding-cn', models: MODELS }, dryRun: true });
  assert.equal(result.status, 'dry-run');
  assert.equal(result.ops, 1);
  assert.equal(settings.state.calls.length, 0);
});

test('a missing settings namespace or service is skipped', async () => {
  const without = await writeRoute({ settings: { describe: () => [], mutate: async () => {} }, request: { route: 'r', models: MODELS } });
  assert.equal(without.status, 'skipped');
  const empty = await writeRoute({ request: { route: 'r', models: MODELS } });
  assert.equal(empty.status, 'skipped');
});

test('companion route config is written only when the route does not carry it yet', async () => {
  const settings = settingsService({ providers: { 'openrouter-live': { baseURL: 'https://mine.example/v1' } } });
  const result = await writeRoute({
    settings,
    request: { route: 'openrouter-live', models: MODELS, api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
  });
  assert.equal(result.status, 'wrote');
  const ops = settings.state.calls[0].ops.map((op) => op.path.join('.'));
  assert.deepEqual(ops, ['providers.openrouter-live.models', 'providers.openrouter-live.api', 'providers.openrouter-live.apiKeyEnv']);
  assert.equal(settings.state.user.providers['openrouter-live'].baseURL, 'https://mine.example/v1');
});

test('requestsForPlan keeps the original route untouched on a companion plan', () => {
  const plan = {
    route: 'openrouter',
    mode: 'companion',
    routeModels: [],
    routeApi: undefined,
    companionModels: [{ id: 'stealth/union-alpha' }],
    companionSpec: { route: 'openrouter-live', api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1' },
  };
  const requests = requestsForPlan(plan, { apiKeyEnv: 'OPENROUTER_API_KEY' });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    route: 'openrouter-live',
    models: [{ id: 'stealth/union-alpha' }],
    api: 'openai-completions',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  });
});

test('requestsForPlan writes the managed route in place and forces the api under route-api', () => {
  const inPlace = requestsForPlan({ route: 'zai-coding-cn', mode: 'in-place', routeModels: MODELS, routeApi: undefined, companionModels: [] }, undefined);
  assert.deepEqual(inPlace, [{ route: 'zai-coding-cn', models: MODELS, api: undefined }]);
  const forced = requestsForPlan({ route: 'openrouter', mode: 'route-api', routeModels: MODELS, routeApi: 'openai-completions', companionModels: [] }, undefined);
  assert.equal(forced[0].api, 'openai-completions');
});
