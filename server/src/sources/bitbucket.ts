import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RepoInput } from '../analyzer/analyze.js';

const exec = promisify(execFile);

export interface BitbucketAuth {
  token?: string;
  username?: string;
  password?: string;
}

export interface BitbucketSource {
  type: 'bitbucket-cloud' | 'bitbucket-server';
  baseUrl?: string;
  workspace?: string;
  projectKey?: string;
  repos?: string[];
  repoFilter?: string;
  branch?: string;
  auth?: BitbucketAuth;
}

interface RepoRef {
  slug: string;
  fullName: string;
  cloneUrl: string;
  branch: string;
  webBase: string;
  webUrl: (file: string, line: number, branch: string) => string;
}

export function authFromEnv(auth: BitbucketAuth = {}): BitbucketAuth {
  if (auth.token || (auth.username && auth.password)) return auth;
  return {
    token: process.env.BITBUCKET_TOKEN || process.env.BITBUCKET_ACCESS_TOKEN || undefined,
    username: process.env.BITBUCKET_USERNAME || undefined,
    password: process.env.BITBUCKET_APP_PASSWORD || process.env.BITBUCKET_API_TOKEN || undefined
  };
}

function authHeader(auth: BitbucketAuth): string | undefined {
  if (auth.token) return `Bearer ${auth.token}`;
  if (auth.username && auth.password) return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  return undefined;
}

async function getJson(url: string, auth: BitbucketAuth): Promise<any> {
  const header = authHeader(auth);
  const res = await fetch(url, { headers: { Accept: 'application/json', ...(header ? { Authorization: header } : {}) } });
  if (!res.ok) throw new Error(`Bitbucket API ${res.status} ${res.statusText} for ${new URL(url).pathname}`);
  return res.json();
}

async function listCloudRepos(src: BitbucketSource, auth: BitbucketAuth): Promise<RepoRef[]> {
  if (!src.workspace) throw new Error('workspace is required for Bitbucket Cloud');
  const api = (src.baseUrl || 'https://api.bitbucket.org/2.0').replace(/\/$/, '');
  const q = src.projectKey ? `&q=${encodeURIComponent(`project.key="${src.projectKey}"`)}` : '';
  let url: string | undefined = `${api}/repositories/${encodeURIComponent(src.workspace)}?pagelen=100${q}`;
  const out: RepoRef[] = [];
  while (url) {
    const page: any = await getJson(url, auth);
    for (const r of page.values ?? []) {
      const clone = (r.links?.clone ?? []).find((c: any) => c.name === 'https')?.href;
      if (!clone) continue;
      const webBase = r.links?.html?.href ?? `https://bitbucket.org/${r.full_name}`;
      out.push({
        slug: r.slug,
        fullName: r.full_name,
        cloneUrl: clone.replace(/\/\/[^@/]+@/, '//'),
        branch: src.branch || r.mainbranch?.name || 'main',
        webBase,
        webUrl: (file, line, branch) => `${webBase}/src/${encodeURIComponent(branch)}/${file.split(path.sep).join('/')}#lines-${line}`
      });
    }
    url = page.next;
  }
  return out;
}

async function listServerRepos(src: BitbucketSource, auth: BitbucketAuth): Promise<RepoRef[]> {
  if (!src.baseUrl || !src.projectKey) throw new Error('baseUrl and projectKey are required for Bitbucket Data Center / Server');
  const base = src.baseUrl.replace(/\/$/, '');
  const out: RepoRef[] = [];
  let start = 0;
  for (;;) {
    const page: any = await getJson(`${base}/rest/api/1.0/projects/${encodeURIComponent(src.projectKey)}/repos?limit=100&start=${start}`, auth);
    for (const r of page.values ?? []) {
      const clone = (r.links?.clone ?? []).find((c: any) => c.name === 'http' || c.name === 'https')?.href;
      if (!clone) continue;
      const webBase = `${base}/projects/${r.project.key}/repos/${r.slug}`;
      out.push({
        slug: r.slug,
        fullName: `${r.project.key}/${r.slug}`,
        cloneUrl: clone.replace(/\/\/[^@/]+@/, '//'),
        branch: src.branch || '',
        webBase,
        webUrl: (file, line, branch) => `${webBase}/browse/${file.split(path.sep).join('/')}${branch ? `?at=${encodeURIComponent(`refs/heads/${branch}`)}` : ''}#${line}`
      });
    }
    if (page.isLastPage !== false) break;
    start = page.nextPageStart;
  }
  return out;
}

// Credentials go to git through GIT_CONFIG_* env vars (http.extraHeader), never on the command line or in .git/config.
async function git(args: string[], auth: BitbucketAuth, cwd?: string) {
  const header = authHeader(auth);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (header) Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: ${header}` });
  try {
    return await exec('git', args, { cwd, env, maxBuffer: 16 * 1024 * 1024 });
  } catch (e: any) {
    const msg = String(e.stderr || e.message).replace(/Authorization:[^\n]*/gi, 'Authorization: ***');
    throw new Error(`git ${args[0]} failed: ${msg.trim().split('\n').slice(-2).join(' ')}`);
  }
}

async function syncRepo(r: RepoRef, cacheDir: string, auth: BitbucketAuth): Promise<string> {
  const dir = path.join(cacheDir, r.fullName.replace(/[^\w.-]+/g, '__'));
  if (existsSync(path.join(dir, '.git'))) {
    await git(['fetch', '--depth', '1', 'origin', r.branch || 'HEAD'], auth, dir);
    await git(['reset', '--hard', 'FETCH_HEAD'], auth, dir);
  } else {
    mkdirSync(path.dirname(dir), { recursive: true });
    await git(['clone', '--depth', '1', '--single-branch', ...(r.branch ? ['--branch', r.branch] : []), r.cloneUrl, dir], auth);
  }
  if (!r.branch) r.branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], auth, dir)).stdout.trim();
  return dir;
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}

export async function fetchBitbucketRepos(src: BitbucketSource, cacheDir: string, onProgress: (m: string) => void): Promise<{ repos: RepoInput[]; warnings: string[] }> {
  const auth = authFromEnv(src.auth);
  let refs = src.type === 'bitbucket-cloud' ? await listCloudRepos(src, auth) : await listServerRepos(src, auth);
  if (src.repos?.length) {
    const wanted = new Set(src.repos.map(s => s.toLowerCase()));
    refs = refs.filter(r => wanted.has(r.slug.toLowerCase()) || wanted.has(r.fullName.toLowerCase()));
  }
  if (src.repoFilter) {
    const re = new RegExp(src.repoFilter, 'i');
    refs = refs.filter(r => re.test(r.slug));
  }
  onProgress(`Found ${refs.length} repositories in Bitbucket`);
  const warnings: string[] = [];
  const repos = await pool(refs, 4, async r => {
    try {
      const dir = await syncRepo(r, cacheDir, auth);
      onProgress(`Cloned ${r.fullName}@${r.branch}`);
      return { repo: r.fullName, dir, repoWebUrl: r.webBase, webUrl: (f: string, l: number) => r.webUrl(f, l, r.branch) } as RepoInput;
    } catch (e) {
      warnings.push(`${r.fullName}: ${(e as Error).message}`);
      return undefined;
    }
  });
  return { repos: repos.filter(Boolean) as RepoInput[], warnings };
}
