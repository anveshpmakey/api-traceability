import type { GraphEdge, GraphNode, ScanResult, Trace, TraceChain, TraceLevel } from './types.js';

const MAX_CHAINS = 300;

export function computeTrace(result: ScanResult, endpointId: string, level: TraceLevel = 'method', maxDepth = 40): Trace | undefined {
  const endpoint = result.endpoints.find(e => e.id === endpointId);
  if (!endpoint) return undefined;
  const nodes = new Map(result.nodes.map(n => [n.id, n]));
  const out = new Map<string, GraphEdge[]>();
  const inc = new Map<string, GraphEdge[]>();
  for (const e of result.edges) {
    (out.get(e.source) ?? out.set(e.source, []).get(e.source)!).push(e);
    (inc.get(e.target) ?? inc.set(e.target, []).get(e.target)!).push(e);
  }
  const root = `ep:${endpointId}`;
  const down = bfs(root, out, 'target', maxDepth);
  const up = bfs(root, inc, 'source', maxDepth);

  const side = new Map<string, 'upstream' | 'root' | 'downstream'>([[root, 'root']]);
  for (const id of down.visited) if (!side.has(id)) side.set(id, 'downstream');
  for (const id of up.visited) if (!side.has(id)) side.set(id, 'upstream');
  const edges = [...new Map([...down.edges, ...up.edges].map(e => [e.id, e])).values()];

  const chains: TraceChain[] = [
    ...paths(root, down.edges, 'target').map(p => toChain('downstream', p, nodes)),
    ...paths(root, up.edges, 'source').map(p => toChain('upstream', p.reverse(), nodes))
  ];

  const all = [...side.keys()].map(id => nodes.get(id)).filter(Boolean) as GraphNode[];
  const services = (ids: Set<string>) => [...new Set([...ids].map(id => nodes.get(id)?.service).filter(s => s && s !== endpoint.service))] as string[];
  const stats = {
    upstreamServices: services(up.visited),
    downstreamServices: services(down.visited),
    tables: [...new Set(all.filter(n => n.kind === 'table' && side.get(n.id) === 'downstream').map(n => `${n.service}.${n.label}`))],
    topics: [...new Set(all.filter(n => n.kind === 'topic').map(n => n.label))],
    externals: [...new Set(all.filter(n => n.kind === 'external').map(n => n.label))]
  };

  const collapsed = collapse(all, edges, level, root);
  return {
    endpoint,
    level,
    nodes: collapsed.nodes.map(n => ({ ...n, side: n.id === root ? 'root' : (collapsed.side(n.id, side) ?? 'downstream') })),
    edges: collapsed.edges,
    chains: level === 'method' ? chains : dedupeChains(chains.map(c => ({ ...c, steps: collapseSteps(c.steps, collapsed.map) }))),
    stats
  };
}

function bfs(start: string, adj: Map<string, GraphEdge[]>, dir: 'source' | 'target', maxDepth: number) {
  const visited = new Set([start]);
  const edges: GraphEdge[] = [];
  let frontier = [start];
  for (let depth = 0; frontier.length && depth < maxDepth; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of adj.get(id) ?? []) {
        edges.push(e);
        const n = e[dir];
        if (!visited.has(n)) {
          visited.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return { visited, edges };
}

function paths(root: string, edges: GraphEdge[], dir: 'source' | 'target'): string[][] {
  const from = dir === 'target' ? 'source' : 'target';
  const adj = new Map<string, string[]>();
  for (const e of edges) (adj.get(e[from]) ?? adj.set(e[from], []).get(e[from])!).push(e[dir]);
  const out: string[][] = [];
  const walk = (id: string, path: string[]) => {
    if (out.length >= MAX_CHAINS) return;
    const next = (adj.get(id) ?? []).filter(n => !path.includes(n));
    if (!next.length) {
      if (path.length > 1) out.push(path);
      return;
    }
    for (const n of next) walk(n, [...path, n]);
  };
  walk(root, [root]);
  return out;
}

function toChain(direction: TraceChain['direction'], ids: string[], nodes: Map<string, GraphNode>): TraceChain {
  return {
    direction,
    steps: ids.map(id => {
      const n = nodes.get(id);
      return { id, kind: n?.kind ?? 'method', label: n?.label ?? id, service: n?.service };
    })
  };
}

function groupId(n: GraphNode, level: TraceLevel, root: string): string {
  if (n.id === root || level === 'method') return n.id;
  if (level === 'class') {
    if ((n.kind === 'method' || n.kind === 'listener' || n.kind === 'repository') && n.className) return `cls:${n.service}:${n.className}`;
    return n.id;
  }
  if (n.kind === 'topic' || n.kind === 'external') return n.id;
  return n.service ? `svc:${n.service}` : n.id;
}

function collapse(nodes: GraphNode[], edges: GraphEdge[], level: TraceLevel, root: string) {
  const map = new Map<string, string>();
  const grouped = new Map<string, GraphNode>();
  for (const n of nodes) {
    const gid = groupId(n, level, root);
    map.set(n.id, gid);
    if (grouped.has(gid)) continue;
    if (gid === n.id) grouped.set(gid, n);
    else if (gid.startsWith('cls:')) {
      const simple = n.className!.slice(n.className!.lastIndexOf('.') + 1);
      grouped.set(gid, { id: gid, kind: n.kind === 'repository' ? 'repository' : 'class', label: simple, service: n.service, className: n.className, ref: n.ref });
    } else grouped.set(gid, { id: gid, kind: 'service', label: n.service!, service: n.service });
  }
  const merged = new Map<string, GraphEdge>();
  for (const e of edges) {
    const s = map.get(e.source);
    const t = map.get(e.target);
    if (!s || !t || s === t) continue;
    const id = `${s}->${t}:${e.kind}`;
    if (!merged.has(id)) merged.set(id, { ...e, id, source: s, target: t });
  }
  return {
    map,
    nodes: [...grouped.values()],
    edges: [...merged.values()],
    side: (gid: string, sides: Map<string, 'upstream' | 'root' | 'downstream'>) => {
      for (const [orig, g] of map) if (g === gid) return sides.get(orig);
      return undefined;
    }
  };
}

function collapseSteps(steps: TraceChain['steps'], map: Map<string, string>): TraceChain['steps'] {
  const out: TraceChain['steps'] = [];
  for (const s of steps) {
    const gid = map.get(s.id) ?? s.id;
    if (out.length && out[out.length - 1].id === gid) continue;
    const label = gid.startsWith('svc:') ? gid.slice(4) : gid.startsWith('cls:') ? gid.slice(gid.lastIndexOf('.') + 1) : s.label;
    out.push({ ...s, id: gid, label, kind: gid.startsWith('svc:') ? 'service' : gid.startsWith('cls:') ? 'class' : s.kind });
  }
  return out;
}

function dedupeChains(chains: TraceChain[]): TraceChain[] {
  const seen = new Set<string>();
  return chains.filter(c => {
    const key = `${c.direction}:${c.steps.map(s => s.id).join('>')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function serviceMap(result: ScanResult) {
  const nodes = new Map(result.nodes.map(n => [n.id, n]));
  const outNodes = new Map<string, GraphNode>();
  const edges = new Map<string, { id: string; source: string; target: string; kind: string; count: number }>();
  const key = (n: GraphNode) => (n.kind === 'topic' || n.kind === 'external' ? n.id : n.service ? `svc:${n.service}` : undefined);
  for (const s of result.services) outNodes.set(`svc:${s.name}`, { id: `svc:${s.name}`, kind: 'service', label: s.name, service: s.name, detail: `${s.endpointCount} endpoints` });
  for (const e of result.edges) {
    if (!['http', 'publishes', 'consumes', 'routes'].includes(e.kind)) continue;
    const a = nodes.get(e.source);
    const b = nodes.get(e.target);
    if (!a || !b) continue;
    const s = key(a);
    const t = key(b);
    if (!s || !t || s === t) continue;
    for (const n of [a, b]) if ((n.kind === 'topic' || n.kind === 'external') && !outNodes.has(n.id)) outNodes.set(n.id, n);
    const id = `${s}->${t}:${e.kind}`;
    const existing = edges.get(id);
    if (existing) existing.count++;
    else edges.set(id, { id, source: s, target: t, kind: e.kind, count: 1 });
  }
  return { nodes: [...outNodes.values()], edges: [...edges.values()] };
}
