import test from 'node:test';
import assert from 'node:assert/strict';

const plugin = await import('../lib/index.js').catch((error) => ({ loadError: error }));
const skip = plugin.loadError === undefined
  ? false
  : `@deepseek-ai/schemastery is not installed next to this checkout (npm install): ${plugin.loadError.message}`;

const CATALOG = {
  'zai-coding-cn': { 'glm-5.3': { id: 'glm-5.3', name: 'GLM-5.3', api: 'openai-completions', contextWindow: 200000, input: ['text'] } },
};

const ONLY = { managedRoutes: ['zai-coding-cn'], startupDelaySeconds: 0, intervalMinutes: 0 };
const DISCOVER = { startupDelaySeconds: 0, intervalMinutes: 0 };

function fakeSettings(userNamespace, ownConfig = {}) {
  const state = { revision: 3, user: { 'llm-pi-ai': userNamespace }, calls: [], watchers: [], registered: [] };
  const scope = {
    get: () => state.resolved,
    watch: (callback) => {
      state.watchers.push(callback);
      return () => {};
    },
  };
  return {
    state,
    describe: () => [{ ns: 'llm-pi-ai', revision: state.revision, user: state.user['llm-pi-ai'], value: state.user['llm-pi-ai'] }],
    mutate: async (ns, ops, revision) => {
      state.calls.push({ ns, ops, revision });
      for (const op of ops) {
        const [group, route, key] = op.path;
        state.user[group] = { ...state.user[group], [route]: { ...state.user[group]?.[route], [key]: op.value } };
      }
    },
    register: (ns, schema) => {
      state.registered.push(ns);
      state.resolved = schema(ownConfig);
      return scope;
    },
  };
}

function fakeContext(settings, llm) {
  const effects = [];
  const commands = { registered: [], register(definition) { this.registered.push(definition); return () => {}; } };
  const ctx = {
    settings,
    llm,
    commands,
    logger: { info() {}, warn() {}, debug() {} },
    effect(callback, label) {
      const dispose = callback();
      effects.push({ label, dispose });
      return dispose;
    },
    inject(names, callback) {
      callback(this);
    },
  };
  return { ctx, effects, commands };
}

function stubCatalog(catalog) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(catalog), { status: 200, headers: { 'content-type': 'application/json' } });
  return () => {
    globalThis.fetch = original;
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

const TIMEOUT = { timeout: 10000 };

test('the plugin declares its name, settings injection, and namespace', { skip, ...TIMEOUT }, () => {
  assert.equal(plugin.name, 'dsh-pi-catalog-sync');
  assert.deepEqual(plugin.inject, ['settings']);
  const settings = fakeSettings({});
  const { ctx } = fakeContext(settings);
  plugin.apply(ctx);
  assert.deepEqual(settings.state.registered, ['pi-catalog-sync']);
});

test('the startup round syncs a managed route through the settings seam', { skip, ...TIMEOUT }, async () => {
  const restore = stubCatalog(CATALOG);
  try {
    const settings = fakeSettings({ providers: { 'zai-coding-cn': { baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4' } } }, ONLY);
    const { ctx } = fakeContext(settings);
    plugin.apply(ctx);
    assert.equal(await waitFor(() => settings.state.calls.length > 0), true, 'the startup round never wrote');
    const write = settings.state.calls.find((call) => call.ops[0].path[1] === 'zai-coding-cn');
    assert.ok(write !== undefined);
    assert.equal(write.revision, 3);
    assert.deepEqual(write.ops[0].value.map((model) => model.id), ['glm-5.3']);
  } finally {
    restore();
  }
});

test('routes are discovered from the resolved llm-pi-ai namespace when managedRoutes is empty', { skip, ...TIMEOUT }, async () => {
  const restore = stubCatalog(CATALOG);
  try {
    const settings = fakeSettings({ providers: { 'zai-coding-cn': { baseURL: 'https://example.test/v1' } } }, DISCOVER);
    const { ctx } = fakeContext(settings);
    plugin.apply(ctx);
    assert.equal(await waitFor(() => settings.state.calls.length > 0), true, 'route discovery never wrote');
    assert.equal(settings.state.calls.length, 1);
    assert.equal(settings.state.calls[0].ops[0].path[1], 'zai-coding-cn');
  } finally {
    restore();
  }
});

test('the slash command is registered and reports the round', { skip, ...TIMEOUT }, async () => {
  const restore = stubCatalog(CATALOG);
  try {
    const settings = fakeSettings({ providers: { 'zai-coding-cn': { baseURL: 'https://example.test/v1' } } }, ONLY);
    const { ctx, commands } = fakeContext(settings);
    plugin.apply(ctx);
    assert.equal(commands.registered.length, 1);
    const definition = commands.registered[0];
    assert.equal(definition.name, 'pi-catalog-sync');
    const result = await definition.handler({ rawInput: '' });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /zai-coding-cn: single-protocol \(openai-completions\) → in-place/);
  } finally {
    restore();
  }
});

test('--dry-run never reaches the settings service', { skip, ...TIMEOUT }, async () => {
  const restore = stubCatalog(CATALOG);
  try {
    const settings = fakeSettings({ providers: { 'zai-coding-cn': { baseURL: 'https://example.test/v1' } } }, ONLY);
    const { ctx, commands } = fakeContext(settings);
    plugin.apply(ctx);
    const before = settings.state.calls.length;
    const result = await commands.registered[0].handler({ rawInput: '--dry-run' });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /dry run/);
    assert.equal(settings.state.calls.length, before);
  } finally {
    restore();
  }
});

test('an unreachable catalog fails the command without throwing', { skip, ...TIMEOUT }, async () => {
  const restore = stubCatalog(CATALOG);
  try {
    const settings = fakeSettings({ providers: { 'zai-coding-cn': {} } }, ONLY);
    const { ctx, commands } = fakeContext(settings);
    plugin.apply(ctx);
    globalThis.fetch = async () => ({ ok: false, status: 503, headers: new Map() });
    const result = await commands.registered[0].handler({ rawInput: '' });
    assert.equal(result.kind, 'error');
    assert.match(result.text, /503/);
  } finally {
    restore();
  }
});
