import express, { type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { computeTrace, serviceMap } from './analyzer/trace.js';
import type { TraceLevel } from './analyzer/types.js';
import { allowedRoots } from './sources/local.js';
import type { ScanSource, ScanStore } from './store.js';

export function createApp(store: ScanStore, webDir?: string) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const result = (req: Request, res: Response) => {
    const scan = store.get(req.params.id);
    if (!scan) return void res.status(404).json({ error: 'scan not found' });
    if (!scan.result) return void res.status(409).json({ error: `scan is ${scan.summary.status}` });
    return scan.result;
  };

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/config', (_req, res) =>
    res.json({ localRoots: allowedRoots(), bitbucketEnvAuth: !!(process.env.BITBUCKET_TOKEN || process.env.BITBUCKET_ACCESS_TOKEN || process.env.BITBUCKET_APP_PASSWORD || process.env.BITBUCKET_API_TOKEN) })
  );
  app.get('/api/scans', (_req, res) => res.json(store.list()));

  app.post('/api/scans', (req, res) => {
    const { source, name } = req.body as { source?: ScanSource; name?: string };
    if (!source || !['local', 'bitbucket-cloud', 'bitbucket-server'].includes(source.type)) {
      return void res.status(400).json({ error: 'source.type must be local, bitbucket-cloud or bitbucket-server' });
    }
    if (source.type === 'local' && (!Array.isArray(source.paths) || !source.paths.length)) return void res.status(400).json({ error: 'source.paths is required' });
    res.status(202).json(store.start(source, name));
  });

  app.get('/api/scans/:id', (req, res) => {
    const scan = store.get(req.params.id);
    if (!scan) return void res.status(404).json({ error: 'scan not found' });
    res.json({ ...scan.summary, warningList: scan.result?.warnings ?? [] });
  });

  app.delete('/api/scans/:id', (req, res) => {
    store.delete(req.params.id);
    res.status(204).end();
  });

  app.get('/api/scans/:id/services', (req, res) => {
    const r = result(req, res);
    if (r) res.json(r.services);
  });

  app.get('/api/scans/:id/endpoints', (req, res) => {
    const r = result(req, res);
    if (!r) return;
    const counts = new Map<string, { up: number; down: number }>();
    for (const e of r.edges) {
      if (e.kind === 'http' || e.kind === 'routes') {
        const id = e.target.slice(3);
        const c = counts.get(id) ?? { up: 0, down: 0 };
        c.up++;
        counts.set(id, c);
      }
    }
    res.json(r.endpoints.map(e => ({ ...e, inbound: counts.get(e.id)?.up ?? 0 })));
  });

  app.get('/api/scans/:id/trace', (req, res) => {
    const r = result(req, res);
    if (!r) return;
    const level = (['method', 'class', 'service'].includes(String(req.query.level)) ? req.query.level : 'method') as TraceLevel;
    const t = computeTrace(r, String(req.query.endpoint ?? ''), level, Number(req.query.depth) || 40);
    if (!t) return void res.status(404).json({ error: 'endpoint not found' });
    res.json(t);
  });

  app.get('/api/scans/:id/service-map', (req, res) => {
    const r = result(req, res);
    if (r) res.json(serviceMap(r));
  });

  app.get('/api/scans/:id/export', (req, res) => {
    const r = result(req, res);
    if (!r) return;
    const rows = [['endpoint_service', 'method', 'path', 'direction', 'chain']];
    for (const e of r.endpoints) {
      const t = computeTrace(r, e.id, 'class');
      for (const c of t?.chains ?? []) rows.push([e.service, e.method, e.path, c.direction, c.steps.map(s => (s.service && s.kind !== 'service' ? `${s.service}:${s.label}` : s.label)).join(' -> ')]);
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="traceability-${req.params.id}.csv"`);
    res.send(rows.map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'));
  });

  if (webDir && existsSync(webDir)) {
    app.use(express.static(webDir));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
  }
  return app;
}
