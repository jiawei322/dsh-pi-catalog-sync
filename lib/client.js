window.__ModuleLoader__.load({
  id: 'dsh-pi-catalog-sync',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const h = React.createElement;
    const NS = 'pi-catalog-sync';
    const SETTINGS_NS = 'llm-pi-ai';
    const SLOT = 'settings.models.provider-card';

    const inject = ['slots', 'locale', 'remote', 'remote.settings'];

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    function buildRequest(dryRun, now) {
      return { at: now, dryRun: dryRun === true };
    }

    function isPending(section) {
      const request = section?.request;
      if (request === null || request === undefined || typeof request !== 'object') return false;
      if (typeof request.at !== 'number') return false;
      const handled = typeof section?.report?.requestAt === 'number' ? section.report.requestAt : Number.NEGATIVE_INFINITY;
      return request.at > handled;
    }

    function routeRows(section) {
      const routes = section?.report?.routes;
      if (!Array.isArray(routes)) return [];
      return routes.map((row) => ({
        route: row.route,
        mode: row.mode,
        piDev: row.piDev ?? 0,
        builtin: row.builtin ?? 0,
        novelty: row.novelty ?? 0,
        dropped: row.dropped ?? 0,
        companion: row.companion ?? undefined,
        writes: Array.isArray(row.writes) ? row.writes.map((write) => `${write.route}: ${write.status}`).join(' · ') : '',
      }));
    }

    function routeLine(row) {
      const shape = row.mode === 'in-place' ? '原地' : row.mode === 'companion' ? `伴生 → ${row.companion ?? '?'}` : row.mode;
      const counts = `pi.dev ${row.piDev} · 内置 ${row.builtin} · 新增 ${row.novelty}${row.dropped > 0 ? ` · 丢弃 ${row.dropped}` : ''}`;
      return `${row.route} · ${shape} · ${counts}${row.writes === '' ? '' : ` · ${row.writes}`}`;
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.75rem', border: '1px solid rgba(128,128,128,0.35)', borderRadius: '0.5rem' },
      title: { fontWeight: 600, fontSize: '0.875rem' },
      line: { fontSize: '0.8125rem', opacity: 0.85, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      muted: { fontSize: '0.8125rem', opacity: 0.6 },
      actions: { display: 'flex', gap: '0.5rem' },
      button: { fontSize: '0.8125rem', padding: '0.25rem 0.625rem', borderRadius: '0.375rem', cursor: 'pointer' },
      error: { fontSize: '0.8125rem', color: '#c0392b' },
    };

    class Panel extends React.Component {
      constructor(props) {
        super(props);
        this.state = { status: 'loading', payload: {}, revision: undefined, error: undefined, busy: false };
      }

      async componentDidMount() {
        const refresh = this.props.refresh;
        this.unsubscribe = typeof refresh?.subscribe === 'function' ? refresh.subscribe(() => { void this.load(); }) : undefined;
        await this.load();
      }

      componentWillUnmount() {
        if (typeof this.unsubscribe === 'function') this.unsubscribe();
      }

      async load() {
        const face = this.props.getSettings();
        if (face?.describe === undefined) {
          this.setState({ status: 'unavailable' });
          return;
        }
        try {
          const described = await face.describe();
          const entry = Array.isArray(described) ? described.find((candidate) => candidate.ns === NS) : undefined;
          this.setState({ status: 'ready', payload: entry?.value ?? entry?.user ?? {}, revision: entry?.revision, error: undefined });
        } catch (error) {
          this.setState({ status: 'error', error: messageOf(error) });
        }
      }

      async request(dryRun) {
        const face = this.props.getSettings();
        if (face?.mutate === undefined) {
          this.setState({ error: 'settings remote unavailable' });
          return;
        }
        const revision = this.state.revision;
        this.setState({ busy: true });
        try {
          await face.mutate(NS, [{ op: 'set', path: ['request'], value: buildRequest(dryRun, Date.now()) }], revision);
          this.setState({ busy: false });
          await this.load();
        } catch (error) {
          this.setState({ busy: false, error: messageOf(error) });
        }
      }

      render() {
        const { status, payload, error, busy } = this.state;
        const pending = isPending(payload);
        const rows = routeRows(payload);
        const report = payload?.report;
        const children = [
          h('div', { key: 'title', style: styles.title }, 'pi.dev 目录同步 · catalog sync'),
        ];

        if (status === 'loading') children.push(h('div', { key: 'loading', style: styles.muted }, '读取设置中… / reading settings…'));
        if (status === 'unavailable') children.push(h('div', { key: 'unavailable', style: styles.muted }, `设置服务不可用 / settings remote unavailable（${NS}）`));
        if (report !== undefined && report !== null) {
          const stamp = typeof report.at === 'number' ? new Date(report.at).toLocaleString() : '?';
          children.push(h('div', { key: 'report', style: styles.muted }, `最近一轮 / last round: ${report.trigger ?? '?'} · ${stamp}${report.dryRun === true ? ' · dry-run' : ''}`));
        } else if (status === 'ready') {
          children.push(h('div', { key: 'noreport', style: styles.muted }, '还没有同步记录 / no round recorded yet'));
        }
        for (const row of rows) children.push(h('div', { key: `row-${row.route}`, style: styles.line }, routeLine(row)));
        if (rows.length === 0 && status === 'ready') {
          children.push(h('div', { key: 'noroute', style: styles.muted }, '没有已同步的路由 / no route synced yet — 检查 pi-catalog-sync.managedRoutes'));
        }
        if (pending) children.push(h('div', { key: 'pending', style: styles.muted }, '已请求同步，等待 host 完成… / request pending…'));
        if (error !== undefined) children.push(h('div', { key: 'error', style: styles.error }, error));
        children.push(h('div', { key: 'actions', style: styles.actions }, [
          h('button', { key: 'preview', style: styles.button, disabled: busy || pending, onClick: () => { void this.request(true); } }, '预览 / preview (dry-run)'),
          h('button', { key: 'sync', style: styles.button, disabled: busy || pending, onClick: () => { void this.request(false); } }, '立即同步 / sync now'),
        ]));
        return h('div', { className: 'dsh-pi-catalog-sync-card', style: styles.root }, children);
      }
    }

    function apply(ctx) {
      const listeners = new Set();
      const refresh = {
        subscribe(callback) {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
        notify() {
          for (const listener of [...listeners]) listener();
        },
      };
      const getSettings = () => {
        try {
          return ctx.get('remote')?.settings;
        } catch {
          return undefined;
        }
      };

      ctx.effect(() => {
        try {
          return ctx.remote.$on('settings/document-updated', (ns) => {
            if (ns === NS || ns === SETTINGS_NS) refresh.notify();
          });
        } catch {
          return () => {};
        }
      }, 'dsh-pi-catalog-sync: document events');

      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, {
            zh: { 'catalog.sync.title': 'pi.dev 目录同步' },
            en: { 'catalog.sync.title': 'pi.dev catalog sync' },
          });
        } catch {
          return () => {};
        }
      }, 'dsh-pi-catalog-sync: dictionaries');

      ctx.slots.inject(SLOT, () => {
        try {
          const unregister = ctx.slots.register({
            name: SLOT,
            key: SETTINGS_NS,
            id: 'pi-catalog-sync',
            inject: () => ({ getSettings, refresh }),
          }, Panel);
          return () => {
            unregister();
          };
        } catch {
          return () => {};
        }
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.Panel = Panel;
    exports.buildRequest = buildRequest;
    exports.isPending = isPending;
    exports.routeRows = routeRows;
    exports.routeLine = routeLine;
    return module.exports;
  },
});
