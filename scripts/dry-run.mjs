import fs from 'node:fs';
import { fetchPiDevCatalog, catalogEntries } from '../lib/source.js';
import { readInstalledCatalog, installedCatalogDir } from '../lib/pi-ai-catalog.js';
import { buildPlan } from '../lib/plan.js';

const ROUTES = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['openrouter', 'zai-coding-cn', 'opencode-go', 'minimax-cn'];
const COMPANION = { route: 'openrouter-live', api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' };

async function catalog() {
  try {
    const { catalog } = await fetchPiDevCatalog();
    return catalog;
  } catch (error) {
    const cached = JSON.parse(fs.readFileSync('/tmp/pidev-all.json', 'utf8'));
    console.error('# live fetch failed (' + error.message + '); using /tmp/pidev-all.json');
    return cached;
  }
}

const catalogData = await catalog();
console.log('# installed catalog dir: ' + (installedCatalogDir() ?? 'unresolved (api set inferred from pi.dev)'));
console.log('# pi.dev routes: ' + Object.keys(catalogData).length + '\n');

for (const route of ROUTES) {
  const entries = catalogEntries(catalogData, route);
  const installedModels = readInstalledCatalog(route);
  const installed = installedModels === undefined
    ? { ids: new Set(), apis: new Set() }
    : { ids: new Set(installedModels.map((m) => m.id)), apis: new Set(installedModels.map((m) => m.api)) };
  const plan = buildPlan({ route, entries, installed, options: { mixedProtocolStrategy: 'companion', companion: COMPANION, keepBuiltinOnly: true } });

  console.log('== ' + route + ' ==');
  console.log('  pi.dev entries=' + entries.length + ' installed=' + installed.ids.size + ' installed apis=' + [...installed.apis].join('|'));
  console.log('  mode=' + plan.mode + ' route.models=' + plan.routeModels.length + ' route.api=' + (plan.routeApi ?? '(unchanged)') + ' companion.models=' + plan.companionModels.length);
  if (plan.routeApi !== undefined) console.log('  forced route api: ' + plan.routeApi);
  if (plan.companionModels.length > 0) console.log('  companion route: ' + COMPANION.route + ' (api ' + COMPANION.api + ', ' + COMPANION.baseURL + ')');
  for (const dropped of plan.dropped.slice(0, 5)) console.log('  DROPPED ' + dropped.id + ' — ' + dropped.reason);
  if (plan.dropped.length > 5) console.log('  ... ' + (plan.dropped.length - 5) + ' more dropped');
  for (const warning of plan.warnings.slice(0, 3)) console.log('  WARN ' + warning.id + ' — ' + warning.reason);
  const preview = (plan.companionModels.length > 0 ? plan.companionModels : plan.routeModels).slice(0, 3);
  for (const model of preview) console.log('  sample: ' + JSON.stringify(model));
  console.log('');
}
