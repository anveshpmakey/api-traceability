import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'target', 'build', 'out', 'dist', '.idea', '.gradle', '.mvn', 'bin', 'test', 'tests']);

export interface DiscoveredModule {
  dir: string;
  javaFiles: string[];
  artifactId?: string;
}

// A module is any directory with src/main (Maven/Gradle layout); a repo may contain many of them.
export function findModules(root: string, maxDepth = 6): DiscoveredModule[] {
  const out: DiscoveredModule[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    if (existsSync(path.join(dir, 'src/main'))) {
      out.push({ dir, javaFiles: listJava(path.join(dir, 'src/main')), artifactId: readArtifactId(dir) });
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e) || e.startsWith('.') || e === 'src') continue;
      const p = path.join(dir, e);
      try {
        if (statSync(p).isDirectory()) visit(p, depth + 1);
      } catch {
        // unreadable entries are skipped
      }
    }
  };
  visit(root, 0);
  return out;
}

function listJava(dir: string): string[] {
  const files: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.java')) files.push(p);
    }
  }
  return files.sort();
}

function readArtifactId(dir: string): string | undefined {
  const pom = path.join(dir, 'pom.xml');
  if (existsSync(pom)) {
    const xml = readFileSync(pom, 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<parent>[\s\S]*?<\/parent>/, '')
      .replace(/<(dependencies|dependencyManagement|build|plugins|profiles)>[\s\S]*?<\/\1>/g, '');
    return xml.match(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/)?.[1];
  }
  for (const f of ['settings.gradle', 'settings.gradle.kts']) {
    const p = path.join(dir, f);
    if (existsSync(p)) return readFileSync(p, 'utf8').match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/)?.[1];
  }
  return undefined;
}
