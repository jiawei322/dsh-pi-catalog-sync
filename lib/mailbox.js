export function requestOf(section) {
  const request = section?.request;
  if (request === null || request === undefined || typeof request !== 'object' || Array.isArray(request)) return undefined;
  const at = request.at;
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  return { at, dryRun: request.dryRun === true };
}

export function isFreshRequest(request, lastHandledAt) {
  if (request === undefined) return false;
  return lastHandledAt === undefined || request.at > lastHandledAt;
}

export function reportOf(section) {
  const report = section?.report;
  if (report === null || report === undefined || typeof report !== 'object' || Array.isArray(report)) return undefined;
  return report;
}

export function summarizeRound({ plans, results, at, trigger, dryRun, etag, requestAt }) {
  return {
    at,
    trigger,
    dryRun: dryRun === true,
    etag: etag ?? null,
    requestAt: typeof requestAt === 'number' ? requestAt : null,
    routes: plans.map((plan) => ({
      route: plan.route,
      mode: plan.mode,
      protocols: plan.protocols ?? [],
      piDev: plan.piDevCount ?? 0,
      builtin: plan.builtinCount ?? 0,
      novelty: plan.noveltyCount ?? 0,
      dropped: plan.dropped.length,
      warnings: plan.warnings.length,
      companion: plan.companionSpec?.route ?? null,
      writes: results.filter((result) => result.route === plan.route || result.route === plan.companionSpec?.route).map((result) => ({
        route: result.route,
        status: result.status,
        models: result.models ?? null,
        reason: result.reason ?? null,
      })),
    })),
  };
}
