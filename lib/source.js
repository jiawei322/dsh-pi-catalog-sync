export const CATALOG_URL = 'https://pi.dev/api/models';

export async function fetchPiDevCatalog({ etag, timeoutMs = 30000, signal, fetchImpl = fetch } = {}) {
  const headers = { accept: 'application/json' };
  if (typeof etag === 'string' && etag.length > 0) headers['if-none-match'] = etag;
  const response = await fetchImpl(CATALOG_URL, {
    headers,
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 304) return { notModified: true, etag };
  if (!response.ok) throw new Error(`pi.dev catalog answered ${String(response.status)}`);
  const body = await response.json();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('pi.dev catalog is not a provider map');
  return { notModified: false, etag: response.headers.get('etag') ?? undefined, catalog: body };
}

export function catalogRoutes(catalog) {
  return Object.keys(catalog ?? {}).filter((route) => isEntryMap(catalog[route]));
}

export function catalogEntries(catalog, route) {
  const models = catalog?.[route];
  if (!isEntryMap(models)) return [];
  return Object.entries(models).map(([id, entry]) => ({ id, ...entry }));
}

function isEntryMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
