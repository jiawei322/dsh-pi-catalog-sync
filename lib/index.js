import z from '@deepseek-ai/schemastery';
import { createSyncEngine } from './sync.js';
import { findSettingsDescriptor } from './writer.js';
import { requestOf, isFreshRequest, reportOf } from './mailbox.js';

export const name = 'dsh-pi-catalog-sync';
export const inject = ['settings'];

const OWN_NS = 'pi-catalog-sync';

const Config = z.object({
  managedRoutes: z.array(z.string()).default([]),
  mixedProtocolStrategy: z.union(['companion', 'route-api', 'skip']).default('companion'),
  companions: z.array(z.object({
    source: z.string(),
    route: z.string(),
    api: z.string().default('openai-completions'),
    baseURL: z.string(),
    apiKeyEnv: z.string(),
  })).default([]),
  keepBuiltinOnly: z.boolean().default(true),
  forceMaxReasoningEffort: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  intervalMinutes: z.number().step(1).min(0).default(240),
  startupDelaySeconds: z.number().step(1).min(0).default(10),
  catalogTimeoutMs: z.number().step(1).min(1000).default(30000),
  request: z.any().default(null),
  report: z.any().default(null),
});

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function optionalService(ctx, key) {
  try {
    return ctx[key];
  } catch {
    return undefined;
  }
}

export function apply(ctx) {
  const scope = ctx.settings.register(OWN_NS, Config);

  const engine = createSyncEngine({
    settings: ctx.settings,
    config: () => scope.get(),
    logger: ctx.logger,
    listRoutes: () => Object.keys(findSettingsDescriptor(ctx.settings)?.value?.providers ?? {}),
    listModelIds: async (route) => {
      const llm = optionalService(ctx, 'llm');
      if (llm?.listModels === undefined) return [];
      try {
        const models = await llm.listModels(route);
        return models.map((model) => model.id);
      } catch {
        return [];
      }
    },
  });

  let inFlight;
  const syncNow = (dryRun, trigger) => {
    inFlight ??= engine.syncNow({ dryRun, trigger }).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const publishReport = async (summary) => {
    const descriptor = findSettingsDescriptor(ctx.settings, OWN_NS);
    if (descriptor === undefined || ctx.settings.mutate === undefined) return;
    try {
      await ctx.settings.mutate(OWN_NS, [{ op: 'set', path: ['report'], value: summary }], descriptor.revision);
    } catch (error) {
      ctx.logger.debug('pi-catalog-sync: report not published: %s', messageOf(error));
    }
  };

  const runRound = async (label, dryRun, requestAt) => {
    try {
      const { report, summary } = await syncNow(dryRun, label);
      for (const line of report.split('\n')) ctx.logger.info('pi-catalog-sync: %s', line);
      await publishReport({ ...summary, requestAt: requestAt ?? null });
      return { report };
    } catch (error) {
      ctx.logger.warn('pi-catalog-sync: %s round failed: %s', label, messageOf(error));
      return { error };
    }
  };

  const lastReport = reportOf(scope.get());
  let lastHandledAt = typeof lastReport?.requestAt === 'number' ? lastReport.requestAt : undefined;
  const bootRequestPending = isFreshRequest(requestOf(scope.get()), lastHandledAt);
  ctx.effect(() => {
    const accept = (section) => {
      const request = requestOf(section);
      if (!isFreshRequest(request, lastHandledAt)) return;
      lastHandledAt = request.at;
      void runRound('ui', request.dryRun, request.at);
    };
    accept(scope.get());
    const unwatch = scope.watch((next) => accept(next));
    return () => {
      unwatch?.();
    };
  }, 'dsh-pi-catalog-sync: ui requests');

  ctx.effect(() => {
    let stopTimers = () => {};
    const schedule = () => {
      stopTimers();
      const config = scope.get();
      const handles = bootRequestPending
        ? []
        : [setTimeout(() => void runRound('first'), config.startupDelaySeconds * 1000)];
      if (config.intervalMinutes > 0) handles.push(setInterval(() => void runRound('scheduled'), config.intervalMinutes * 60_000));
      for (const handle of handles) handle.unref?.();
      stopTimers = () => {
        for (const handle of handles) {
          clearTimeout(handle);
          clearInterval(handle);
        }
      };
    };
    schedule();
    const unwatch = scope.watch(() => schedule());
    return () => {
      unwatch?.();
      stopTimers();
    };
  }, 'dsh-pi-catalog-sync: refresh schedule');

  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.effect(() => {
      const commands = optionalService(cmdCtx, 'commands');
      if (commands?.register === undefined) return () => {};
      return commands.register({
        name: 'pi-catalog-sync',
        description: 'Sync the pi.dev model catalog into llm-pi-ai provider routes (dsh-pi-catalog-sync)',
        handler: async (invocation) => {
          const dryRun = /(^|\s)--dry-run(\s|$)/.test(invocation.rawInput);
          try {
            const { report, error } = await runRound('command', dryRun);
            if (error !== undefined) return { kind: 'error', text: `pi-catalog-sync failed: ${messageOf(error)}` };
            return { kind: 'success', text: report };
          } catch (error) {
            return { kind: 'error', text: `pi-catalog-sync failed: ${messageOf(error)}` };
          }
        },
      });
    }, 'dsh-pi-catalog-sync: /pi-catalog-sync');
  });
}
