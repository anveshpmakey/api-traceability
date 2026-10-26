import { useEffect, useState } from 'react';
import { api, type ServiceMap } from '../api';
import { Graph, Legend } from './Graph';

export function ServiceMapView({ scanId }: { scanId: string }) {
  const [map, setMap] = useState<ServiceMap>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api.serviceMap(scanId).then(setMap, e => setError(e.message));
  }, [scanId]);
  if (error) return <div className="error">{error}</div>;
  if (!map) return <div className="empty">Loading…</div>;
  return (
    <div className="trace">
      <div className="graph-area full">
        <Graph nodes={map.nodes} edges={map.edges.map(e => ({ ...e, label: `${e.kind} ×${e.count}` }))} />
      </div>
      <Legend />
    </div>
  );
}
