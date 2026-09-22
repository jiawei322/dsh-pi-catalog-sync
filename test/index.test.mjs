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
const ZAI = { 'zai-coding-cn': { baseURL: 'https://example.test/v1' } };

function applyOp(target, op) {
  const [head, ...rest] = op.path;
  if (rest.length === 0) {
    if (op.op === 'unset') {
      const { [head]: removed, ...kept } = target;
      return kept;
    }
    return { ...target, [head]: op.value };
  }
  return { ...target, [head]: applyOp(target[head] ?? {}, { op: 'set', path: rest, value: op.value }) };
}

function fakeSettings(sections = {}, ownConfig = {}) {
  const state = {
    revision: 3,
    sections: { 'pi-catalog-sync': ownConfig, ...sections },
    calls: [],
    watchers: [],
    registered: [],
    schema: undefined,
  };
  const emit = (section) => {
    state.sections['pi-catalog-sync'] = section;
    state.resolved = state.schema === undefined ? {} : state.schema(section);
    for (const watcher of [...state.watchers]) watcher(state.resolved);
  };
  const scope = {
    get: () => state.resolved,
    watch: (callback) => {
      state.watchers.push(callback);
      return () => {};
    },
  };
  return {
    state,
    emit,
    own: () => state.sections['pi-catalog-sync'],
    describe: () => Object.entries(state.sections).map(([ns, value]) => ({ ns, revision: state.revision, user: value, value })),
    mutate: async (ns, ops, revision) => {
      state.calls.push({ ns, ops, revision });
      let section = state.sections[ns] ?? {};
      for (const op of ops) section = applyOp(section, op);
      if (ns === 'pi-catalog-sync') emit(section);
      else state.sections[ns] = section;
    },
    register: (ns, schema) => {
      state.registered.push(ns);
      state.schema = schema;
      state.resolved = schema(state.sections['pi-catalog-sync'] ?? {});
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

const writes = (settings, ns) => settings.state.calls.filter((call) => call.ns === ns);
const TIMEOUT = { timeout: 10000 };

test('the plugin declares its name, settings injection, and namespace', { skip, ...TIMEOUT }, () => {
  assert.equal(plugin.name, 'dsh-pi-catalog-sync');
  assert.deepEqual(plugin.inject, ['settings']);
  const settings = fakeSettings();
  const { ctx } = fakeContext(settings);
  plugin.apply(ctx);
  assert.deepEqual(settings.state.registered, ['pi-catalog-sync']);
});

test('the startup round syncs a managed route and publishes the round report', { skip, ...TIMEOUT }, async () => {
  const restore = stubCatalog(CATALOG);
  try {
    const settings = fakeSettings({ 'llm-pi-ai': { providers: ZAI } }, ONLY);
    const { ctx } = fakeContext(settings);
    plugin.apply(ctx);
    assert.equal(await waitFor(() => settings.own().report !== undefined && settings.own().report !== null), true, 'no report published');
    const write = writes(settings, 'llm-pi-ai')[0];
    assert.equal(write.revision, 3);
    assert.deepEqual(write.ops[0].value.map((model) => model.id), ['glm-5.3']);
    const report = settings.own().report;
    assert.equal(report.trigger, 'first');
    assert.equal(report.dryRun, false);
    assert.deepEqual(report.routes.map((route) => route.route), ['zai-coding-cn']);
    assert.equal(report.routes[0].piDev, 1);
    assert.deepEqual(report.routes[0].writes.map((entry) => entry.status), ['wrote']);
  } finally {
    restore();
  }
});

test('routes are discovered from the resolved llm-pi-ai namespace when managedRoutes is empty', { skip, ...TIMEOUT }, async () => {
  const restore = stubCatalog(CATALOG);
  try {
    const settings = fakeSettings({ 'llm-pi-ai': { providers: ZAI } }, DISCOVER);
    const { ctx } = fakeContext(settings);
    plugin.apply(ctx);
    assert.equal(await waitFor(() => writes(settings, 'llm-pi-ai').length > 0), true, 'route discovery never wrote');
    assert.equal(writes(settings, 'llm-pi-ai')[0].ops[0].path[1], 'zai-coding-cn');
  } finally {
    restore();
  }
});

test('the slash command runs a round and returns the text report', { skip, ...TIMEOUT }, async () => {
  const restore = stubCatalog(CATALOG);
  try {
    const settings = fakeSettings({ 'llm-pi-ai': { providers: ZAI } }, ONLY);
    const { ctx, commands } = fakeContext(settings);
    plugin.apply(ctx);
    const definition = commands.registered[0];
    assert.equal(definition.name, 'pi-catalog-sync');
    const result = await definition.handler({ rawInput: '' });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /zai-coding-cn: single-protocol \(openai-completions\) → in-place/);
    assert.equal(settings.own().report.trigger, 'command');
  } finally {
    restore();
  }
});

test('--dry-run reaches neither llm-pi-ai nor the startup path', { skip, ...TIMEOUT }, async () => {
  const restore = stubCatalog(CATALOG);
  try {
    const settings = fakeSettings({ 'llm-pi-ai': { providers: ZAI } }, ONLY);
    const { ctx, commands } = fakeContext(settings);
    plugin.apply(ctx);
    const result = await commands.registered[0].handler({ rawInput: '--dry-run' });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /dry run/);
    assert.equal(writes(settings, 'llm-pi-ai').length, 0);
    assert.equal(settings.own().report.dryRun, true);
  } finally {
    restore();
  }
});

test('a request written by the settings UI runs a round and publishes trigger ui', { skip, ...TIMEOUT }, async () => {
  const restore = stubCatalog(CATALOG);
  try {
    const settings = fakeSettings({ 'llm-pi-ai': { providers: ZAI } }, { ...ONLY, request: { at: 1000, dryRun: true } });
    const { ctx } = fakeContext(settings);
    plugin.apply(ctx);
    assert.equal(await waitFor(() => settings.own().report !== undefined && settings.own().report !== null), true, 'no report published');
    assert.equal(settings.own().report.trigger, 'ui');
    assert.equal(settings.own().report.dryRun, true);
    assert.equal(writes(settings, 'llm-pi-ai').length, 0, 'a preview request must not write models');
  } finally {
    restore();
  }
});

test('a boot request suppresses the startup round, and a later request is honoured exactly once', { skip, ...TIMEOUT }, async () => {
  const restore = stubCatalog(CATALOG);
  try {
    const settings = fakeSettings({ 'llm-pi-ai': { providers: ZAI } }, { ...ONLY, request: { at: 1000, dryRun: true } });
    const { ctx } = fakeContext(settings);
    plugin.apply(ctx);
    assert.equal(await waitFor(() => settings.own().report !== undefined && settings.own().report !== null), true);
    assert.equal(settings.own().report.trigger, 'ui');
    const rounds = writes(settings, 'pi-catalog-sync').length;
    const firstReportAt = settings.own().report.at;

    settings.emit({ ...settings.own(), request: { at: 1000, dryRun: true } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(writes(settings, 'pi-catalog-sync').length, rounds, 'the same request must not replay');
    assert.equal(settings.own().report.at, firstReportAt);

    settings.emit({ ...settings.own(), request: { at: 2000, dryRun: false } });
    assert.equal(await waitFor(() => settings.own().report.requestAt === 2000), true, 'the new request never ran');
    assert.equal(settings.own().report.trigger, 'ui');
    assert.equal(settings.own().report.dryRun, false);
    assert.equal(writes(settings, 'llm-pi-ai').length, 1);
  } finally {
    restore();
  }
});

test('an unreachable catalog fails the command without throwing', { skip, ...TIMEOUT }, async () => {
  const restore = stubCatalog(CATALOG);
  try {
    const settings = fakeSettings({ 'llm-pi-ai': { providers: ZAI } }, ONLY);
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
