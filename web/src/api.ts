import type { Endpoint, GraphNode, ScanSummary, ServiceInfo, Trace, TraceLevel } from '../../server/src/analyzer/types';

export type { Endpoint, GraphNode, ScanSummary, ServiceInfo, Trace, TraceLevel };
export type EndpointRow = Endpoint & { inbound: number };
export type ScanDetail = ScanSummary & { warningList: string[] };
export interface ServiceMap {
  nodes: GraphNode[];
  edges: { id: string; source: string; target: string; kind: string; count: number }[];
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  config: () => req<{ localRoots: string[]; bitbucketEnvAuth: boolean }>('/api/config'),
  scans: () => req<ScanSummary[]>('/api/scans'),
  scan: (id: string) => req<ScanDetail>(`/api/scans/${id}`),
  startScan: (source: unknown, name?: string) => req<ScanSummary>('/api/scans', { method: 'POST', body: JSON.stringify({ source, name }) }),
  deleteScan: (id: string) => req<void>(`/api/scans/${id}`, { method: 'DELETE' }),
  services: (id: string) => req<ServiceInfo[]>(`/api/scans/${id}/services`),
  endpoints: (id: string) => req<EndpointRow[]>(`/api/scans/${id}/endpoints`),
  trace: (id: string, endpoint: string, level: TraceLevel) => req<Trace>(`/api/scans/${id}/trace?endpoint=${encodeURIComponent(endpoint)}&level=${level}`),
  serviceMap: (id: string) => req<ServiceMap>(`/api/scans/${id}/service-map`),
  exportUrl: (id: string) => `/api/scans/${id}/export`
};
