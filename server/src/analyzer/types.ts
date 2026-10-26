// Shared between the analyzer, the API and the web UI.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS' | 'ANY';

export interface SourceRef {
  service: string;
  file: string;
  line: number;
  url?: string;
}

export interface Endpoint {
  id: string;
  service: string;
  method: HttpMethod;
  path: string;
  className: string;
  methodName: string;
  handlerId: string;
  ref: SourceRef;
}

export type NodeKind =
  | 'endpoint'
  | 'method'
  | 'listener'
  | 'repository'
  | 'table'
  | 'topic'
  | 'external'
  | 'unresolved'
  | 'gateway'
  | 'class'
  | 'service';

export type EdgeKind = 'handles' | 'calls' | 'http' | 'publishes' | 'consumes' | 'reads' | 'writes' | 'routes';

export type Confidence = 'high' | 'medium' | 'low';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  service?: string;
  className?: string;
  detail?: string;
  ref?: SourceRef;
  endpointId?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
  confidence: Confidence;
  ref?: SourceRef;
}

export interface ServiceInfo {
  name: string;
  repo: string;
  modulePath: string;
  webUrl?: string;
  endpointCount: number;
  classCount: number;
  contextPath: string;
}

export interface ScanSummary {
  id: string;
  name: string;
  status: 'running' | 'done' | 'failed';
  createdAt: string;
  finishedAt?: string;
  source: string;
  progress: string[];
  error?: string;
  services?: number;
  endpoints?: number;
  warnings?: number;
}

export interface ScanResult {
  services: ServiceInfo[];
  endpoints: Endpoint[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: string[];
}

export type TraceLevel = 'method' | 'class' | 'service';

export interface TraceChain {
  direction: 'upstream' | 'downstream';
  steps: { id: string; kind: NodeKind; label: string; service?: string }[];
}

export interface Trace {
  endpoint: Endpoint;
  level: TraceLevel;
  nodes: (GraphNode & { side: 'upstream' | 'root' | 'downstream' })[];
  edges: GraphEdge[];
  chains: TraceChain[];
  stats: { upstreamServices: string[]; downstreamServices: string[]; tables: string[]; topics: string[]; externals: string[] };
}
