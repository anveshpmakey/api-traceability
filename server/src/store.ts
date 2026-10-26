import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { analyzeRepos, type RepoInput } from './analyzer/analyze.js';
import type { ScanResult, ScanSummary } from './analyzer/types.js';
import { fetchBitbucketRepos, type BitbucketSource } from './sources/bitbucket.js';
import { localRepos } from './sources/local.js';

export type ScanSource = BitbucketSource | { type: 'local'; paths: string[] };

export interface StoredScan {
  summary: ScanSummary;
  result?: ScanResult;
}

export class ScanStore {
  private scans = new Map<string, StoredScan>();

  constructor(private dataDir: string) {
    mkdirSync(path.join(dataDir, 'scans'), { recursive: true });
    for (const f of readdirSync(path.join(dataDir, 'scans'))) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(readFileSync(path.join(dataDir, 'scans', f), 'utf8')) as StoredScan;
        this.scans.set(s.summary.id, s);
      } catch {
        // ignore corrupt scan files
      }
    }
  }

  list(): ScanSummary[] {
    return [...this.scans.values()].map(s => s.summary).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string) {
    return this.scans.get(id);
  }

  delete(id: string) {
    this.scans.delete(id);
    rmSync(path.join(this.dataDir, 'scans', `${id}.json`), { force: true });
  }

  start(source: ScanSource, name?: string): ScanSummary {
    const id = randomUUID().slice(0, 8);
    const summary: ScanSummary = { id, name: name || describe(source), status: 'running', createdAt: new Date().toISOString(), source: describe(source), progress: [] };
    const scan: StoredScan = { summary };
    this.scans.set(id, scan);
    void this.run(scan, source);
    return summary;
  }

  async runSync(source: ScanSource, name?: string): Promise<StoredScan> {
    const summary = this.start(source, name);
    const scan = this.scans.get(summary.id)!;
    while (scan.summary.status === 'running') await new Promise(r => setTimeout(r, 50));
    return scan;
  }

  private async run(scan: StoredScan, source: ScanSource) {
    const progress = (m: string) => scan.summary.progress.push(m);
    try {
      let repos: RepoInput[];
      const warnings: string[] = [];
      if (source.type === 'local') {
        repos = localRepos(source.paths);
      } else {
        const r = await fetchBitbucketRepos(source, path.join(this.dataDir, 'repos'), progress);
        repos = r.repos;
        warnings.push(...r.warnings);
      }
      const result = await analyzeRepos(repos, progress);
      result.warnings.unshift(...warnings);
      scan.result = result;
      Object.assign(scan.summary, { status: 'done', finishedAt: new Date().toISOString(), services: result.services.length, endpoints: result.endpoints.length, warnings: result.warnings.length });
    } catch (e) {
      Object.assign(scan.summary, { status: 'failed', finishedAt: new Date().toISOString(), error: (e as Error).message });
    }
    writeFileSync(path.join(this.dataDir, 'scans', `${scan.summary.id}.json`), JSON.stringify(scan));
  }
}

function describe(s: ScanSource): string {
  if (s.type === 'local') return `local: ${s.paths.join(', ')}`;
  if (s.type === 'bitbucket-cloud') return `bitbucket.org/${s.workspace}${s.projectKey ? ` (project ${s.projectKey})` : ''}`;
  return `${s.baseUrl} project ${s.projectKey}`;
}

export function hasScans(dataDir: string) {
  return existsSync(path.join(dataDir, 'scans')) && readdirSync(path.join(dataDir, 'scans')).length > 0;
}
