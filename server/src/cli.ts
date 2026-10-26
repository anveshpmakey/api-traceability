import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyzeRepos } from './analyzer/analyze.js';
import { computeTrace } from './analyzer/trace.js';
import { fetchBitbucketRepos } from './sources/bitbucket.js';
import { localRepos } from './sources/local.js';

const { values } = parseArgs({
  options: {
    local: { type: 'string', multiple: true },
    workspace: { type: 'string' },
    'base-url': { type: 'string' },
    project: { type: 'string' },
    repos: { type: 'string' },
    branch: { type: 'string' },
    endpoint: { type: 'string' },
    out: { type: 'string' }
  }
});

let repos;
if (values.local?.length) {
  process.env.LOCAL_SCAN_ROOTS ??= values.local.map(p => path.resolve(p)).join(',');
  repos = localRepos(values.local);
} else if (values.workspace || values['base-url']) {
  const type = values['base-url'] && !values.workspace ? 'bitbucket-server' : 'bitbucket-cloud';
  const r = await fetchBitbucketRepos(
    { type, workspace: values.workspace, baseUrl: values['base-url'], projectKey: values.project, branch: values.branch, repos: values.repos?.split(',') },
    path.resolve(process.env.DATA_DIR || 'data', 'repos'),
    m => console.error(m)
  );
  repos = r.repos;
} else {
  console.error('Usage: npm run analyze -- --local <dir> | --workspace <ws> [--project KEY] | --base-url <url> --project KEY  [--endpoint "svc|GET /path"] [--out result.json]');
  process.exit(1);
}

const result = await analyzeRepos(repos, m => console.error(m));
if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2));
const targets = values.endpoint ? result.endpoints.filter(e => e.id === values.endpoint) : result.endpoints;
for (const e of targets) {
  console.log(`\n${e.service}  ${e.method} ${e.path}`);
  for (const c of computeTrace(result, e.id, 'class')?.chains ?? []) console.log(`  ${c.direction === 'upstream' ? '<-' : '->'} ${c.steps.map(s => s.label).join(' → ')}`);
}
for (const w of result.warnings) console.error(`warning: ${w}`);
