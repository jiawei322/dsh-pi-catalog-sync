const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function isPositiveInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function deriveReasoningEfforts(entry, force) {
  const map = entry.thinkingLevelMap;
  const efforts = {};
  if (map !== null && typeof map === 'object') {
    for (const level of THINKING_LEVELS) {
      const wire = nonEmptyString(map[level]);
      if (wire !== undefined) efforts[level] = wire;
    }
  }
  if (Object.keys(efforts).every((level) => level === 'off')) {
    efforts.low = 'low';
    efforts.high = 'high';
  }
  if (force) {
    efforts.low ??= 'low';
    efforts.high ??= 'high';
    efforts.max ??= 'max';
  }
  return efforts;
}

export function toProfile(entry, { baseMatching, forceMaxReasoningEffort = false }) {
  const profile = { id: entry.id };
  const name = nonEmptyString(entry.name);
  if (name !== undefined) profile.name = name;
  if (isPositiveInt(entry.contextWindow)) profile.contextWindow = entry.contextWindow;
  if (Array.isArray(entry.input) && entry.input.length > 0) profile.input = [...entry.input];
  if (!baseMatching && isPositiveInt(entry.maxTokens) && (profile.contextWindow === undefined || entry.maxTokens < profile.contextWindow)) {
    profile.maxTokens = entry.maxTokens;
  }
  const compat = entry.compat ?? {};
  const thinkingFormat = nonEmptyString(compat.thinkingFormat);
  if (thinkingFormat !== undefined && (forceMaxReasoningEffort || compat.supportsReasoningEffort !== false)) {
    profile.reasoningEfforts = deriveReasoningEfforts(entry, forceMaxReasoningEffort);
  }
  if (entry.api === 'openai-completions') {
    const written = {};
    if (thinkingFormat !== undefined) written.thinkingFormat = thinkingFormat;
    if (typeof compat.supportsReasoningEffort === 'boolean') written.supportsReasoningEffort = compat.supportsReasoningEffort;
    if (forceMaxReasoningEffort && thinkingFormat !== undefined) written.supportsReasoningEffort = true;
    if (Object.keys(written).length > 0) profile.compat = written;
  }
  return profile;
}

function commonBaseUrl(entries) {
  const baseUrls = new Set(entries.map((entry) => nonEmptyString(entry.baseUrl)).filter((baseUrl) => baseUrl !== undefined));
  return baseUrls.size === 1 ? [...baseUrls][0] : undefined;
}

function stubsFor(ids, present) {
  return [...ids].filter((id) => !present.has(id)).sort().map((id) => ({ id }));
}

export function buildPlan({ route, entries, installed = {}, options = {} }) {
  const installedIds = installed.ids ?? new Set();
  const keepBuiltinOnly = options.keepBuiltinOnly !== false;
  const forceMaxReasoningEffort = options.forceMaxReasoningEffort === true;
  const strategy = options.mixedProtocolStrategy ?? 'companion';
  const dropped = [];
  const warnings = [];

  if (entries.length === 0) {
    return { route, mode: 'none', reason: 'pi.dev lists no models for this route', routeModels: [], companionModels: [], dropped, warnings, piDevCount: 0, builtinCount: installedIds.size, noveltyCount: 0, protocols: [] };
  }

  const listedApis = new Set(entries.map((entry) => entry.api).filter((api) => api !== undefined));
  const installedApis = installed.apis instanceof Set ? installed.apis : new Set();
  const apiSet = installedApis.size > 0 ? installedApis : listedApis;
  const mixed = apiSet.size > 1;

  const baseMatching = (entry) => installedIds.size === 0 || installedIds.has(entry.id);
  const baseLessApis = new Set(entries.filter((entry) => !baseMatching(entry)).map((entry) => entry.api).filter((api) => api !== undefined));
  const counts = {
    piDevCount: entries.length,
    builtinCount: installedIds.size,
    noveltyCount: entries.filter((entry) => !baseMatching(entry)).length,
    protocols: [...apiSet].sort(),
  };

  if (!mixed) {
    const present = new Set(entries.map((entry) => entry.id));
    const models = entries.map((entry) => toProfile(entry, { baseMatching: installedIds.has(entry.id), forceMaxReasoningEffort }));
    if (keepBuiltinOnly) models.push(...stubsFor(installedIds, present));
    models.sort((a, b) => a.id.localeCompare(b.id));
    return { route, mode: 'in-place', routeModels: models, routeApi: undefined, companionModels: [], dropped, warnings, ...counts };
  }

  if (strategy === 'skip') {
    warnings.push({ id: '*', route, reason: `mixed-protocol route (${[...apiSet].join(', ')}); strategy is "skip"` });
    return { route, mode: 'skip', routeModels: [], companionModels: [], dropped, warnings, ...counts };
  }

  if (strategy === 'route-api') {
    const forcedApi = options.routeApi ?? (baseLessApis.size === 1 ? [...baseLessApis][0] : undefined);
    if (forcedApi === undefined) {
      dropped.push({ id: '*', route, reason: `mixed-protocol route and no single api to force (base-less apis: ${[...baseLessApis].join(', ')})`, severity: 'drop' });
      return { route, mode: 'skip', routeModels: [], companionModels: [], dropped, warnings, ...counts };
    }
    const present = new Set(entries.map((entry) => entry.id));
    const models = entries.map((entry) => toProfile(entry, { baseMatching: true, forceMaxReasoningEffort }));
    if (keepBuiltinOnly) models.push(...stubsFor(installedIds, present));
    models.sort((a, b) => a.id.localeCompare(b.id));
    warnings.push({ id: '*', route, reason: `mixed-protocol route: every model is forced onto "${forcedApi}"`, severity: 'degrade' });
    return { route, mode: 'route-api', routeModels: models, routeApi: forcedApi, companionModels: [], dropped, warnings, ...counts };
  }

  const companion = options.companion;
  const novelties = entries.filter((entry) => !baseMatching(entry));
  const known = options.syncKnownOnMixedRoute === true ? entries.filter(baseMatching) : [];
  const companionModels = [];
  const noveltyApis = new Set(novelties.map((entry) => entry.api).filter((api) => api !== undefined));
  const companionSpec = {
    route: nonEmptyString(companion?.route) ?? `${route}-live`,
    api: nonEmptyString(companion?.api) ?? (noveltyApis.size === 1 ? [...noveltyApis][0] : undefined),
    baseURL: nonEmptyString(companion?.baseURL) ?? commonBaseUrl(novelties),
  };
  if (novelties.length === 0) {
    return { route, mode: 'companion', routeModels: [], companionModels: [], dropped, warnings, ...counts };
  }
  if (nonEmptyString(companion?.api) === undefined && companionSpec.api === undefined) {
    for (const entry of novelties) {
      dropped.push({ id: entry.id, route, reason: `base-less entry on a mixed-protocol route speaks ${entry.api ?? 'an unknown protocol'}; the new models span ${String(noveltyApis.size)} protocols, so one companion route cannot carry them`, severity: 'drop' });
    }
    return { route, mode: 'companion', routeModels: [], companionModels: [], dropped, warnings, ...counts };
  }
  if (companion === undefined) {
    for (const entry of novelties) {
      dropped.push({ id: entry.id, route, reason: `base-less entry on a mixed-protocol route has no addressable api; add a companion route (${companionSpec.route}: api ${companionSpec.api}${companionSpec.baseURL === undefined ? '' : `, baseURL ${companionSpec.baseURL}`}) to carry it`, severity: 'drop' });
    }
    return { route, mode: 'companion', routeModels: [], companionModels: [], dropped, warnings, companionSpec, ...counts };
  }
  const keepApi = companionSpec.api;
  for (const entry of novelties) {
    if (entry.api !== undefined && entry.api !== keepApi) {
      dropped.push({ id: entry.id, route, reason: `speaks ${entry.api}, which the companion route "${companionSpec.route}" (api ${keepApi}) cannot serve`, severity: 'drop' });
      continue;
    }
    companionModels.push(toProfile(entry, { baseMatching: false, forceMaxReasoningEffort }));
  }
  companionModels.sort((a, b) => a.id.localeCompare(b.id));
  const knownModels = known.map((entry) => toProfile(entry, { baseMatching: true, forceMaxReasoningEffort }));
  knownModels.sort((a, b) => a.id.localeCompare(b.id));
  return { route, mode: 'companion', routeModels: knownModels, companionModels, dropped, warnings, companionSpec, ...counts };
}
