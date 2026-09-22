import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8');

let loaded;
globalThis.window = { __ModuleLoader__: { load: (definition) => { loaded = definition; } } };
new Function(source)();

function reactStub() {
  class Component {
    constructor(props) {
      this.props = props;
      this.state = {};
    }
    setState(patch) {
      this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) };
    }
  }
  const createElement = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat() } });
  return { Component, createElement };
}

const react = reactStub();
const mod = loaded.factory((name) => {
  if (name === 'react') return react;
  throw new Error(`unexpected require: ${name}`);
});

const REPORT = {
  at: 1_700_000_000_000,
  trigger: 'first',
  dryRun: false,
  requestAt: null,
  routes: [
    { route: 'openrouter', mode: 'companion', protocols: ['anthropic-messages', 'openai-completions'], piDev: 377, builtin: 366, novelty: 23, dropped: 0, companion: 'openrouter-live', writes: [{ route: 'openrouter-live', status: 'wrote', models: 23 }] },
    { route: 'zai-coding-cn', mode: 'in-place', protocols: ['openai-completions'], piDev: 10, builtin: 10, novelty: 0, dropped: 0, companion: null, writes: [{ route: 'zai-coding-cn', status: 'no-change', models: 10 }] },
  ],
};

function faceOf(section) {
  const calls = [];
  return {
    calls,
    describe: async () => [{ ns: 'pi-catalog-sync', revision: 7, user: section, value: section }],
    mutate: async (ns, ops, revision) => {
      calls.push({ ns, ops, revision });
      return { value: { revision: revision + 1 } };
    },
  };
}

function fakeCtx(face) {
  const injections = [];
  let seated;
  const ctx = {
    effects: [],
    effect(callback, label) {
      const dispose = callback();
      this.effects.push({ label, dispose });
      return dispose;
    },
    get(name) {
      if (name === 'remote') return { settings: face, $on: () => () => {} };
      throw new Error(`unknown service: ${name}`);
    },
    remote: { $on: () => () => {} },
    locale: { register: () => () => {} },
    slots: {
      inject(name, callback) {
        injections.push({ name, callback });
      },
      register(options, component) {
        seated = { options, component };
        return () => {};
      },
    },
  };
  return { ctx, injections, seated: () => seated };
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (node === null || typeof node !== 'object') return '';
  return textOf(node.props?.children);
}

function buttonsOf(node, found = []) {
  if (node === null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) buttonsOf(child, found);
    return found;
  }
  if (node.type === 'button') found.push(node);
  buttonsOf(node.props?.children, found);
  return found;
}

async function mount(section) {
  const face = faceOf(section);
  const { ctx, injections, seated } = fakeCtx(face);
  mod.apply(ctx);
  assert.equal(injections.length, 1);
  assert.equal(injections[0].name, 'settings.models.provider-card');
  injections[0].callback();
  const seatedValue = seated();
  assert.ok(seatedValue !== undefined, 'the card was never seated');
  const props = seatedValue.options.inject();
  const instance = new seatedValue.component(props);
  await instance.componentDidMount();
  return { face, instance, seatedValue, props };
}

test('the bundle registers a client plugin with the expected services and slot', () => {
  assert.equal(loaded.id, 'dsh-pi-catalog-sync');
  assert.deepEqual(mod.inject, ['slots', 'locale', 'remote', 'remote.settings']);
  assert.equal(typeof mod.apply, 'function');
  assert.equal(mod.Panel, mod.Panel);
});

test('request helpers mirror the host mailbox rules', () => {
  assert.deepEqual(mod.buildRequest(false, 1234), { at: 1234, dryRun: false });
  assert.deepEqual(mod.buildRequest(true, 1234), { at: 1234, dryRun: true });
  assert.equal(mod.isPending({ request: { at: 5 }, report: { requestAt: 4 } }), true);
  assert.equal(mod.isPending({ request: { at: 5 }, report: { requestAt: 5 } }), false);
  assert.equal(mod.isPending({ request: { at: 5 }, report: null }), true);
  assert.equal(mod.isPending({}), false);
  assert.equal(mod.isPending({ request: { dryRun: true } }), false);
});

test('the card seats into the llm-pi-ai provider card slot', async () => {
  const { seatedValue } = await mount({ report: REPORT });
  assert.equal(seatedValue.options.name, 'settings.models.provider-card');
  assert.equal(seatedValue.options.key, 'llm-pi-ai');
  assert.equal(seatedValue.options.id, 'pi-catalog-sync');
});

test('the card renders the last round and one line per route', async () => {
  const { instance } = await mount({ report: REPORT });
  const text = textOf(instance.render());
  assert.match(text, /pi\.dev 目录同步/);
  assert.match(text, /last round: first/);
  assert.match(text, /openrouter · 伴生 → openrouter-live · pi\.dev 377 · 内置 366 · 新增 23 · openrouter-live: wrote/);
  assert.match(text, /zai-coding-cn · 原地 · pi\.dev 10 · 内置 10 · 新增 0 · zai-coding-cn: no-change/);
  assert.match(text, /立即同步/);
});

test('an empty namespace renders the not-synced hint instead of rows', async () => {
  const { instance } = await mount({});
  const text = textOf(instance.render());
  assert.match(text, /no round recorded yet/);
  assert.match(text, /没有已同步的路由/);
});

test('clicking sync writes a mailbox request with revision fencing', async () => {
  const { instance, face } = await mount({ report: REPORT });
  const syncButton = buttonsOf(instance.render()).find((button) => textOf(button).includes('立即同步'));
  assert.ok(syncButton !== undefined);
  await syncButton.props.onClick();
  assert.equal(face.calls.length, 1);
  assert.equal(face.calls[0].ns, 'pi-catalog-sync');
  assert.equal(face.calls[0].revision, 7);
  assert.equal(face.calls[0].ops[0].path.join('.'), 'request');
  assert.equal(face.calls[0].ops[0].value.dryRun, false);
  assert.equal(typeof face.calls[0].ops[0].value.at, 'number');
});

test('clicking preview asks the host for a dry run', async () => {
  const { instance, face } = await mount({ report: REPORT });
  const previewButton = buttonsOf(instance.render()).find((button) => textOf(button).includes('预览'));
  await previewButton.props.onClick();
  assert.equal(face.calls[0].ops[0].value.dryRun, true);
});

test('a pending request disables both buttons until the host answers', async () => {
  const { instance } = await mount({ report: { ...REPORT, requestAt: null }, request: { at: 2_000_000_000_000, dryRun: false } });
  const text = textOf(instance.render());
  assert.match(text, /request pending/);
  for (const button of buttonsOf(instance.render())) assert.equal(button.props.disabled, true);
});

test('an answered request re-enables the buttons', async () => {
  const { instance } = await mount({ report: { ...REPORT, requestAt: 2_000_000_000_000 }, request: { at: 2_000_000_000_000, dryRun: true } });
  for (const button of buttonsOf(instance.render())) assert.equal(button.props.disabled, false);
});

test('a missing settings remote degrades to a notice instead of throwing', async () => {
  const { ctx, injections, seated } = fakeCtx(undefined);
  mod.apply(ctx);
  injections[0].callback();
  const props = { getSettings: () => undefined, refresh: seated().options.inject().refresh };
  const instance = new (seated().component)(props);
  await instance.componentDidMount();
  assert.match(textOf(instance.render()), /settings remote unavailable/);
});
