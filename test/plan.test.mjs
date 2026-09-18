import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, toProfile } from '../lib/plan.js';

const mixedInstalled = { ids: new Set(['known']), apis: new Set(['anthropic-messages', 'openai-completions']) };
const singleInstalled = { ids: new Set(['known']), apis: new Set(['openai-completions']) };

function entry(id, extra = {}) {
  return {
    id,
    name: id,
    api: 'openai-completions',
    contextWindow: 100000,
    maxTokens: 32000,
    input: ['text', 'image'],
    reasoning: true,
    thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null },
    compat: { thinkingFormat: 'openrouter', supportsDeveloperRole: false },
    ...extra,
  };
}

test('mixed-protocol route sends base-less models to the companion route', () => {
  const plan = buildPlan({
    route: 'openrouter',
    entries: [entry('known'), entry('stealth/union-alpha')],
    installed: mixedInstalled,
    options: { companion: { route: 'openrouter-live', api: 'openai-completions' } },
  });
  assert.equal(plan.mode, 'companion');
  assert.deepEqual(plan.routeModels, []);
  assert.deepEqual(plan.companionModels.map((m) => m.id), ['stealth/union-alpha']);
  assert.deepEqual(plan.dropped, []);
});

test('mixed-protocol route without a companion drops the base-less models with a reason', () => {
  const plan = buildPlan({ route: 'openrouter', entries: [entry('known'), entry('brand-new')], installed: mixedInstalled, options: {} });
  assert.equal(plan.mode, 'companion');
  assert.deepEqual(plan.companionModels, []);
  assert.equal(plan.dropped.length, 1);
  assert.match(plan.dropped[0].reason, /mixed-protocol/);
});

test('mixed-protocol route with route-api strategy forces one api and keeps every model', () => {
  const plan = buildPlan({ route: 'openrouter', entries: [entry('known'), entry('brand-new')], installed: mixedInstalled, options: { mixedProtocolStrategy: 'route-api' } });
  assert.equal(plan.mode, 'route-api');
  assert.equal(plan.routeApi, 'openai-completions');
  assert.deepEqual(plan.routeModels.map((m) => m.id), ['brand-new', 'known']);
  assert.deepEqual(plan.dropped, []);
});

test('single-protocol route syncs in place and keeps builtin-only stubs', () => {
  const plan = buildPlan({
    route: 'zai-coding-cn',
    entries: [entry('glm-5.3')],
    installed: { ids: new Set(['glm-5.3', 'glm-5.2']), apis: new Set(['openai-completions']) },
    options: {},
  });
  assert.equal(plan.mode, 'in-place');
  assert.equal(plan.routeApi, undefined);
  assert.deepEqual(plan.routeModels.map((m) => m.id), ['glm-5.2', 'glm-5.3']);
  assert.deepEqual(plan.routeModels[0], { id: 'glm-5.2' });
  assert.deepEqual(plan.routeModels[1].reasoningEfforts, { off: 'none', low: 'low', high: 'high' });
  assert.deepEqual(plan.routeModels[1].compat, { thinkingFormat: 'openrouter' });
  assert.equal(plan.routeModels[1].maxTokens, undefined);
});

test('base-less capacities are written only when sane', () => {
  const sane = toProfile(entry('new'), { baseMatching: false });
  assert.equal(sane.maxTokens, 32000);
  const echoed = toProfile(entry('new', { contextWindow: 500000, maxTokens: 500000 }), { baseMatching: false });
  assert.equal(echoed.maxTokens, undefined);
  const garbage = toProfile(entry('new', { contextWindow: 1.5, maxTokens: -1 }), { baseMatching: false });
  assert.equal(garbage.contextWindow, undefined);
  assert.equal(garbage.maxTokens, undefined);
});

test('reasoningEfforts is skipped when the provider declares no effort support', () => {
  const profile = toProfile(entry('no-efforts', { compat: { thinkingFormat: 'openrouter', supportsReasoningEffort: false } }), { baseMatching: false });
  assert.equal(profile.reasoningEfforts, undefined);
});

test('force max reasoning effort fills low/high/max and flips supportsReasoningEffort', () => {
  const profile = toProfile(entry('forced', { compat: { thinkingFormat: 'openrouter', supportsReasoningEffort: false } }), { baseMatching: false, forceMaxReasoningEffort: true });
  assert.deepEqual(profile.reasoningEfforts, { off: 'none', low: 'low', high: 'high', max: 'max' });
  assert.equal(profile.compat.supportsReasoningEffort, true);
});

test('a route with no pi.dev entries resolves to no plan', () => {
  const plan = buildPlan({ route: 'ghost', entries: [], installed: { ids: new Set(), apis: new Set() }, options: {} });
  assert.equal(plan.mode, 'none');
});
