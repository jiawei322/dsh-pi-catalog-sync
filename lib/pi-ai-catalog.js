import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const SUBPATH = '@earendil-works/pi-ai/providers/openrouter.models';
const ANCHORS = ['@deepseek-ai/dsh-settings/package.json', '@deepseek-ai/dsh-llm-pi-ai/package.json', '@deepseek-ai/dsh-commands/package.json'];

function rootOf(resolved) {
  const marker = `${path.sep}dist${path.sep}`;
  const at = resolved.indexOf(marker);
  return at === -1 ? undefined : resolved.slice(0, at);
}

function fromAnchor(anchor) {
  let anchorPath;
  try {
    anchorPath = require.resolve(anchor);
  } catch {
    return undefined;
  }
  const scoped = path.dirname(path.dirname(anchorPath));
  const candidates = [
    path.join(scoped, '@earendil-works', 'pi-ai'),
    path.join(path.dirname(scoped), '@earendil-works', 'pi-ai'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'dist', 'providers', 'data'))) return candidate;
  }
  return undefined;
}

function resolvePiAiRoot() {
  try {
    const direct = rootOf(require.resolve(SUBPATH));
    if (direct !== undefined) return direct;
  } catch {
    /* the plugin's own resolution chain rarely owns pi-ai */
  }
  for (const anchor of ANCHORS) {
    const found = fromAnchor(anchor);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function installedCatalogDir() {
  const override = process.env.PI_AI_DATA_DIR;
  if (typeof override === 'string' && override.length > 0) return override;
  const rootDir = resolvePiAiRoot();
  return rootDir === undefined ? undefined : path.join(rootDir, 'dist', 'providers', 'data');
}

export function readInstalledCatalog(route, dir = installedCatalogDir()) {
  if (dir === undefined) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, `${route}.json`), 'utf8'));
  } catch {
    return undefined;
  }
  const models = [];
  for (const api of Object.keys(parsed)) {
    for (const model of Object.values(parsed[api])) models.push({ id: model.id, api: model.api });
  }
  return models;
}
