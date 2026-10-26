import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export type Props = Record<string, string>;

function flatten(value: unknown, prefix: string, out: Props) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (!(prefix in out)) {
    out[prefix] = String(value);
  }
}

export function parseProperties(text: string): Props {
  const out: Props = {};
  const lines = text.replace(/\\\r?\n\s*/g, '').split(/\r?\n/);
  for (const raw of lines) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith('!')) continue;
    const m = l.match(/^([^=:\s]+)\s*[=:\s]\s*(.*)$/);
    if (m && !(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

export function parseYaml(text: string): Props {
  const out: Props = {};
  for (const doc of YAML.parseAllDocuments(text)) {
    const value = doc.toJS({ maxAliasCount: 1000 });
    if (value && typeof value === 'object') {
      const onProfile = (value as Record<string, any>).spring?.config?.activate?.['on-profile'] ?? (value as Record<string, any>).spring?.profiles;
      if (onProfile && Object.keys(out).length) continue;
      flatten(value, '', out);
    }
  }
  return out;
}

const CONFIG_FILE = /^(application|bootstrap)(-[\w-]+)?\.(ya?ml|properties)$/;

// Base application/bootstrap files win; profile-specific files only fill in keys that are missing.
export function loadModuleProps(moduleDir: string): Props {
  const dirs = [path.join(moduleDir, 'src/main/resources'), path.join(moduleDir, 'src/main/resources/config'), path.join(moduleDir, 'config')];
  const files: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (CONFIG_FILE.test(f)) files.push(path.join(dir, f));
  }
  files.sort((a, b) => rank(a) - rank(b));
  const props: Props = {};
  for (const f of files) {
    try {
      const text = readFileSync(f, 'utf8');
      const parsed = f.endsWith('.properties') ? parseProperties(text) : parseYaml(text);
      for (const [k, v] of Object.entries(parsed)) if (!(k in props)) props[k] = v;
    } catch {
      // malformed config files are ignored; the analysis continues with what could be read
    }
  }
  return props;
}

function rank(file: string): number {
  const base = path.basename(file);
  const m = base.match(CONFIG_FILE);
  if (!m) return 99;
  return (m[2] ? 10 : 0) + (m[1] === 'bootstrap' ? 1 : 0);
}

export function resolvePlaceholders(value: string, props: Props, depth = 0): string {
  if (depth > 8 || !value.includes('${')) return value;
  const replaced = value.replace(/\$\{([^${}:]+)(?::([^{}]*))?\}/g, (whole, key: string, def: string | undefined) => {
    const k = key.trim();
    if (k in props) return resolvePlaceholders(props[k], props, depth + 1);
    const relaxed = findRelaxed(props, k);
    if (relaxed !== undefined) return resolvePlaceholders(relaxed, props, depth + 1);
    if (def !== undefined) return def;
    return `\u0000${k}\u0001`;
  });
  return replaced.replace(/\u0000([^\u0001]*)\u0001/g, '${$1}');
}

// Spring relaxed binding: clients.customer.base-url == clients.customer.baseUrl == clients.customer.base_url
function findRelaxed(props: Props, key: string): string | undefined {
  const norm = (k: string) => k.toLowerCase().replace(/[-_]/g, '');
  const target = norm(key);
  for (const [k, v] of Object.entries(props)) if (norm(k) === target) return v;
  const envStyle = key.toUpperCase().replace(/[.-]/g, '_');
  return process.env.API_TRACE_RESOLVE_ENV === '1' ? process.env[envStyle] : undefined;
}

export function listIndexed(props: Props, prefix: string): Props[] {
  const items: Props[] = [];
  const re = new RegExp(`^${prefix.replace(/[.[\]]/g, m => `\\${m}`)}\\[(\\d+)\\]\\.?(.*)$`);
  for (const [k, v] of Object.entries(props)) {
    const m = k.match(re);
    if (!m) continue;
    const i = Number(m[1]);
    items[i] ??= {};
    items[i][m[2]] = v;
  }
  return items.filter(Boolean);
}
