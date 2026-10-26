import { useMemo, useState } from 'react';
import type { EndpointRow } from '../api';

export function MethodBadge({ method }: { method: string }) {
  return <span className={`method method-${method}`}>{method}</span>;
}

export function EndpointList({ endpoints, selected, onSelect }: { endpoints: EndpointRow[]; selected?: string; onSelect: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [method, setMethod] = useState('');
  const groups = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = endpoints.filter(e => {
      const hay = `${e.service} ${e.method} ${e.path} ${e.className} ${e.methodName}`.toLowerCase();
      return (!method || e.method === method) && terms.every(t => hay.includes(t));
    });
    const by = new Map<string, EndpointRow[]>();
    for (const e of filtered) by.set(e.service, [...(by.get(e.service) ?? []), e]);
    return [...by].sort(([a], [b]) => a.localeCompare(b));
  }, [endpoints, q, method]);

  return (
    <div className="ep-list">
      <div className="ep-filters">
        <input placeholder="Search path, service, class…" value={q} onChange={e => setQ(e.target.value)} />
        <select value={method} onChange={e => setMethod(e.target.value)}>
          <option value="">All</option>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY'].map(m => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </div>
      <div className="ep-scroll">
        {groups.map(([svc, eps]) => (
          <div key={svc} className="ep-group">
            <div className="ep-group-title">
              {svc} <span className="muted">({eps.length})</span>
            </div>
            {eps.map(e => (
              <button key={e.id} className={`ep-item ${selected === e.id ? 'active' : ''}`} onClick={() => onSelect(e.id)} title={`${e.className}.${e.methodName}()`}>
                <MethodBadge method={e.method} />
                <span className="ep-path">{e.path}</span>
                {e.inbound > 0 && <span className="pill" title="Inbound callers (services / gateway routes)">↤ {e.inbound}</span>}
              </button>
            ))}
          </div>
        ))}
        {!groups.length && <div className="empty">No endpoints match.</div>}
      </div>
    </div>
  );
}
