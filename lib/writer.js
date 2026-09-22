export const SETTINGS_NAMESPACE = 'llm-pi-ai';
export const SETTINGS_CONFLICT = 'SETTINGS_CONFLICT';

const silent = { info() {}, warn() {}, debug() {} };

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

export function findSettingsDescriptor(settings, namespace = SETTINGS_NAMESPACE) {
  if (settings?.describe === undefined) return undefined;
  return settings.describe().find((section) => section.ns === namespace);
}

export function readRouteSegment(descriptor, route) {
  const providers = descriptor?.user?.providers;
  const segment = providers?.[route];
  return segment !== null && typeof segment === 'object' && !Array.isArray(segment) ? segment : undefined;
}

export function overrideBlockReason(descriptor, route) {
  const overrides = readRouteSegment(descriptor, route)?.modelOverrides;
  if (overrides === null || overrides === undefined || typeof overrides !== 'object') return undefined;
  const ids = Object.keys(overrides);
  if (ids.length === 0) return undefined;
  return `route carries ${String(ids.length)} modelOverrides (${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ', …' : ''}); llm-pi-ai rejects a models list beside modelOverrides`;
}

export function buildOps(route, request, existing) {
  const ops = [{ op: 'set', path: ['providers', route, 'models'], value: request.models }];
  const optional = { api: request.api, baseURL: request.baseURL, apiKeyEnv: request.apiKeyEnv };
  for (const key of ['api', 'baseURL', 'apiKeyEnv']) {
    const value = optional[key];
    if (value === undefined || existing?.[key] !== undefined) continue;
    ops.push({ op: 'set', path: ['providers', route, key], value });
  }
  return ops;
}

function unchanged(descriptor, route, request) {
  const segment = readRouteSegment(descriptor, route);
  if (segment === undefined) return false;
  if (!Array.isArray(segment.models) || !deepEqual(segment.models, request.models)) return false;
  if (request.api !== undefined && segment.api !== request.api) return false;
  return true;
}

export async function writeRoute({ settings, request, dryRun = false, logger = silent }) {
  const route = request.route;
  if (settings?.mutate === undefined) return { route, status: 'skipped', reason: 'settings service unavailable' };
  let descriptor = findSettingsDescriptor(settings);
  if (descriptor === undefined) return { route, status: 'skipped', reason: `settings namespace ${SETTINGS_NAMESPACE} is not registered` };

  let blocked = overrideBlockReason(descriptor, route);
  if (blocked !== undefined) return { route, status: 'skipped', reason: blocked };
  if (unchanged(descriptor, route, request)) return { route, status: 'no-change', models: request.models.length };

  const ops = buildOps(route, request, readRouteSegment(descriptor, route));
  if (dryRun) return { route, status: 'dry-run', models: request.models.length, ops: ops.length };

  try {
    await settings.mutate(SETTINGS_NAMESPACE, ops, descriptor.revision);
    logger.info('pi-catalog-sync: wrote %d models to %s', request.models.length, route);
    return { route, status: 'wrote', models: request.models.length, ops: ops.length };
  } catch (error) {
    if (error?.code !== SETTINGS_CONFLICT) {
      return { route, status: 'rejected', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  descriptor = findSettingsDescriptor(settings);
  if (descriptor === undefined) return { route, status: 'rejected', reason: 'namespace vanished during the conflict retry' };
  blocked = overrideBlockReason(descriptor, route);
  if (blocked !== undefined) return { route, status: 'skipped', reason: blocked };
  if (unchanged(descriptor, route, request)) return { route, status: 'no-change', models: request.models.length };
  try {
    await settings.mutate(SETTINGS_NAMESPACE, buildOps(route, request, readRouteSegment(descriptor, route)), descriptor.revision);
    logger.info('pi-catalog-sync: wrote %d models to %s after a revision conflict', request.models.length, route);
    return { route, status: 'wrote', models: request.models.length, conflictRetry: true };
  } catch (error) {
    return { route, status: 'rejected', reason: error instanceof Error ? error.message : String(error), conflictRetry: true };
  }
}

export function requestsForPlan(plan, companion) {
  const requests = [];
  if (plan.mode === 'route-api' || plan.routeModels.length > 0) {
    requests.push({ route: plan.route, models: plan.routeModels, api: plan.routeApi });
  }
  if (plan.companionModels.length > 0 && plan.companionSpec?.route !== undefined) {
    requests.push({
      route: plan.companionSpec.route,
      models: plan.companionModels,
      api: plan.companionSpec.api,
      baseURL: companion?.baseURL ?? plan.companionSpec.baseURL,
      apiKeyEnv: companion?.apiKeyEnv,
    });
  }
  return requests;
}

export function formatWriteReport(results) {
  const lines = [];
  for (const result of results) {
    const head = result.status === 'wrote'
      ? `wrote ${String(result.models)} models${result.conflictRetry === true ? ' (after a revision conflict)' : ''}`
      : result.status === 'no-change'
        ? `already in sync (${String(result.models)} models)`
        : result.status === 'dry-run'
          ? `dry-run: would write ${String(result.models)} models in ${String(result.ops)} ops`
          : `${result.status}${result.reason === undefined ? '' : ` — ${result.reason}`}`;
    lines.push(`  ${result.route}: ${head}`);
  }
  return lines.join('\n');
}
