import { fetchPiDevCatalog, catalogEntries, catalogRoutes } from './source.js';
import { buildPlan } from './plan.js';
import { readInstalledCatalog } from './pi-ai-catalog.js';
import { writeRoute, requestsForPlan, formatWriteReport } from './writer.js';
import { summarizeRound } from './mailbox.js';

const silent = { info() {}, warn() {}, debug() {} };

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function describePlan(plan, entries) {
  const protocols = plan.protocols ?? [];
  const shape = protocols.length > 1 ? `mixed-protocol (${protocols.join(', ')})` : `single-protocol (${protocols[0] ?? 'unknown'})`;
  const line = `${plan.route}: ${shape} → ${plan.mode}`;
  const stats = `pi.dev ${String(entries.length)} · builtin ${String(plan.builtinCount)} · new ${String(plan.noveltyCount)} · dropped ${String(plan.dropped.length)}`;
  const details = [];
  for (const drop of plan.dropped.slice(0, 5)) details.push(`    dropped ${drop.id}: ${drop.reason}`);
  if (plan.dropped.length > 5) details.push(`    … ${String(plan.dropped.length - 5)} more dropped`);
  for (const warning of plan.warnings.slice(0, 5)) details.push(`    warning ${warning.id}: ${warning.reason}`);
  if (plan.companionSpec !== undefined && plan.companionModels.length > 0) {
    details.push(`    companion ${plan.companionSpec.route} (${plan.companionSpec.api ?? 'unknown api'}${plan.companionSpec.baseURL === undefined ? '' : `, ${plan.companionSpec.baseURL}`})`);
  }
  return { line: `${line}\n  ${stats}`, details };
}

export function createSyncEngine(options) {
  const { settings, logger = silent, listRoutes, listModelIds, fetchCatalog = fetchPiDevCatalog, readBuiltin = readInstalledCatalog } = options;
  const readConfig = typeof options.config === 'function' ? options.config : () => options.config ?? {};
  let catalog;
  let etag;
  let fetchedAt;

  async function loadCatalog() {
    const config = readConfig();
    const result = await fetchCatalog({ etag, timeoutMs: config.catalogTimeoutMs });
    if (result.notModified === true) {
      if (catalog !== undefined) return catalog;
      const retry = await fetchCatalog({ timeoutMs: config.catalogTimeoutMs });
      if (retry.notModified === true) throw new Error('pi.dev answered 304 without a cached catalog');
      catalog = retry.catalog;
      etag = retry.etag;
      fetchedAt = Date.now();
      return catalog;
    }
    catalog = result.catalog;
    etag = result.etag;
    fetchedAt = Date.now();
    return catalog;
  }

  async function installedFor(route) {
    const builtin = readBuiltin(route);
    if (builtin !== undefined && builtin.length > 0) {
      return { ids: new Set(builtin.map((model) => model.id)), apis: new Set(builtin.map((model) => model.api)) };
    }
    if (listModelIds === undefined) return { ids: new Set(), apis: new Set() };
    const ids = await listModelIds(route);
    return { ids: new Set(ids), apis: new Set() };
  }

  function companionFor(route, config) {
    const declared = (config.companions ?? []).find((entry) => entry.source === route);
    if (declared === undefined) return undefined;
    return {
      route: nonEmpty(declared.route),
      api: nonEmpty(declared.api),
      baseURL: nonEmpty(declared.baseURL),
      apiKeyEnv: nonEmpty(declared.apiKeyEnv),
    };
  }

  async function resolveRoutes(catalogData, config) {
    const known = new Set(catalogRoutes(catalogData));
    const desired = config.managedRoutes?.length > 0 ? config.managedRoutes : (listRoutes?.() ?? []);
    return { routes: desired.filter((route) => known.has(route)), skipped: desired.filter((route) => !known.has(route)) };
  }

  async function syncNow({ dryRun, trigger = 'manual' } = {}) {
    const config = readConfig();
    const catalogData = await loadCatalog();
    const { routes, skipped } = await resolveRoutes(catalogData, config);
    const targetDryRun = dryRun ?? config.dryRun === true;
    const plans = [];
    const results = [];
    const sections = [];

    for (const route of routes) {
      const entries = catalogEntries(catalogData, route);
      const plan = buildPlan({
        route,
        entries,
        installed: await installedFor(route),
        options: {
          mixedProtocolStrategy: config.mixedProtocolStrategy,
          companion: companionFor(route, config),
          keepBuiltinOnly: config.keepBuiltinOnly,
          forceMaxReasoningEffort: config.forceMaxReasoningEffort,
        },
      });
      plans.push(plan);
      const described = describePlan(plan, entries);
      const lines = [described.line, ...described.details];
      const routeResults = [];
      for (const request of requestsForPlan(plan, companionFor(route, config))) {
        const result = await writeRoute({ settings, request, dryRun: targetDryRun, logger });
        routeResults.push(result);
        results.push(result);
      }
      if (routeResults.length > 0) lines.push(formatWriteReport(routeResults));
      sections.push(lines.join('\n'));
    }

    const head = [
      `pi.dev catalog: ${String(catalogRoutes(catalogData).length)} routes${etag === undefined ? '' : `, etag ${etag}`}${targetDryRun ? ' (dry run)' : ''}`,
      `managed routes: ${routes.length === 0 ? 'none' : routes.join(', ')}`,
    ];
    if (skipped.length > 0) head.push(`not on pi.dev (skipped): ${skipped.join(', ')}`);
    if (routes.length === 0) head.push('nothing to do — set managedRoutes or configure a provider route DSH knows about');
    const report = [...head, ...sections].join('\n');
    logger.info('pi-catalog-sync: round finished (fetchedAt=%s)', new Date(fetchedAt ?? Date.now()).toISOString());
    const summary = summarizeRound({ plans, results, at: Date.now(), trigger, dryRun: targetDryRun, etag });
    return { report, text: report, plans, results, summary, etag, fetchedAt };
  }

  return { syncNow, loadCatalog, catalogState: () => ({ etag, fetchedAt, hasCatalog: catalog !== undefined }) };
}
