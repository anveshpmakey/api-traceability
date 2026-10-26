import dagre from '@dagrejs/dagre';
import { Background, Controls, MarkerType, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import { useMemo } from 'react';
import type { GraphNode } from '../api';

export interface GraphEdgeIn {
  id: string;
  source: string;
  target: string;
  kind: string;
  label?: string;
  confidence?: string;
}

export const KIND_STYLE: Record<string, { bg: string; border: string; tag: string }> = {
  endpoint: { bg: '#e8f1ff', border: '#2f6fed', tag: 'API' },
  method: { bg: '#ffffff', border: '#9aa4b2', tag: 'method' },
  class: { bg: '#ffffff', border: '#9aa4b2', tag: 'class' },
  listener: { bg: '#fff4e5', border: '#e8890c', tag: 'listener' },
  repository: { bg: '#eefaf0', border: '#2f9e44', tag: 'repo' },
  table: { bg: '#d3f9d8', border: '#2b8a3e', tag: 'table' },
  topic: { bg: '#fff0f6', border: '#c2255c', tag: 'topic' },
  external: { bg: '#f3f0ff', border: '#7048e8', tag: 'external' },
  unresolved: { bg: '#fff5f5', border: '#e03131', tag: 'unresolved' },
  gateway: { bg: '#e3fafc', border: '#0c8599', tag: 'gateway' },
  service: { bg: '#f1f3f5', border: '#495057', tag: 'service' }
};

const EDGE_COLOR: Record<string, string> = {
  http: '#2f6fed',
  publishes: '#c2255c',
  consumes: '#c2255c',
  reads: '#2b8a3e',
  writes: '#e8590c',
  routes: '#0c8599',
  calls: '#868e96',
  handles: '#868e96'
};

const W = 230;
const H = 56;

export function Graph({ nodes, edges, rootId, selected, onSelect }: { nodes: (GraphNode & { side?: string })[]; edges: GraphEdgeIn[]; rootId?: string; selected?: string; onSelect?: (id: string) => void }) {
  const { rfNodes, rfEdges } = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: 18, ranksep: 70 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of nodes) g.setNode(n.id, { width: W, height: H });
    for (const e of edges) g.setEdge(e.source, e.target);
    dagre.layout(g);
    const rfNodes: Node[] = nodes.map(n => {
      const p = g.node(n.id);
      const s = KIND_STYLE[n.kind] ?? KIND_STYLE.method;
      const isRoot = n.id === rootId;
      return {
        id: n.id,
        position: { x: (p?.x ?? 0) - W / 2, y: (p?.y ?? 0) - H / 2 },
        data: {
          label: (
            <div className="gnode" title={n.detail ?? n.label}>
              <div className="gnode-top">
                <span className="gtag" style={{ background: s.border }}>{s.tag}</span>
                {n.service && n.kind !== 'service' && <span className="gsvc">{n.service}</span>}
              </div>
              <div className="glabel">{n.label}</div>
            </div>
          )
        },
        style: {
          width: W,
          background: s.bg,
          border: `${isRoot || n.id === selected ? 3 : 1.5}px solid ${isRoot ? '#1c3faa' : s.border}`,
          borderRadius: 8,
          padding: 6,
          boxShadow: n.id === selected ? '0 0 0 3px rgba(47,111,237,.25)' : undefined
        }
      };
    });
    const rfEdges: Edge[] = edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.kind === 'calls' || e.kind === 'handles' ? undefined : e.kind,
      animated: e.kind === 'http' || e.kind === 'publishes' || e.kind === 'consumes',
      style: { stroke: EDGE_COLOR[e.kind] ?? '#868e96', strokeWidth: e.kind === 'calls' ? 1.2 : 2, strokeDasharray: e.confidence === 'low' ? '5 4' : undefined },
      labelStyle: { fontSize: 10, fill: EDGE_COLOR[e.kind] },
      markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR[e.kind] ?? '#868e96' }
    }));
    return { rfNodes, rfEdges };
  }, [nodes, edges, rootId, selected]);

  return (
    <ReactFlow nodes={rfNodes} edges={rfEdges} fitView minZoom={0.1} nodesDraggable onNodeClick={(_, n) => onSelect?.(n.id)} proOptions={{ hideAttribution: true }}>
      <Background gap={16} color="#eef0f3" />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor={n => (n.style?.border as string)?.split(' ').pop() ?? '#999'} />
    </ReactFlow>
  );
}

export function Legend() {
  return (
    <div className="legend">
      {Object.entries(KIND_STYLE).map(([k, s]) => (
        <span key={k} className="legend-item">
          <span className="legend-swatch" style={{ background: s.bg, borderColor: s.border }} />
          {k}
        </span>
      ))}
      <span className="legend-item">
        <span className="legend-line" style={{ borderColor: EDGE_COLOR.http }} /> http
      </span>
      <span className="legend-item">
        <span className="legend-line" style={{ borderColor: EDGE_COLOR.publishes }} /> messaging
      </span>
      <span className="legend-item">
        <span className="legend-line dashed" /> low confidence
      </span>
    </div>
  );
}
