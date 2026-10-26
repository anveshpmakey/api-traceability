import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { RepoInput } from '../analyzer/analyze.js';

export function allowedRoots(): string[] {
  const env = process.env.LOCAL_SCAN_ROOTS;
  const roots = env ? env.split(',') : [path.resolve('samples')];
  return roots.map(r => path.resolve(r.trim())).filter(Boolean);
}

// Each top-level folder becomes a "repo"; if the path itself is a repo/module it is used directly.
export function localRepos(paths: string[]): RepoInput[] {
  const roots = allowedRoots();
  const out: RepoInput[] = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    if (!roots.some(r => abs === r || abs.startsWith(r + path.sep))) {
      throw new Error(`Path ${p} is outside LOCAL_SCAN_ROOTS (${roots.join(', ')})`);
    }
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`Path ${p} does not exist or is not a directory`);
    const isRepo = existsSync(path.join(abs, '.git')) || existsSync(path.join(abs, 'src/main')) || existsSync(path.join(abs, 'pom.xml')) || existsSync(path.join(abs, 'build.gradle'));
    if (isRepo) {
      out.push({ repo: path.basename(abs), dir: abs });
      continue;
    }
    for (const e of readdirSync(abs)) {
      const d = path.join(abs, e);
      if (!e.startsWith('.') && statSync(d).isDirectory()) out.push({ repo: e, dir: d });
    }
  }
  return out;
}
