import { useEffect, useMemo, useState } from 'react';
import { api, type Trace, type TraceLevel } from '../api';
import { MethodBadge } from './EndpointList';
import { Graph, KIND_STYLE, Legend } from './Graph';

export function TraceView({ scanId, endpointId }: { scanId: string; endpointId: string }) {
  const [level, setLevel] = useState<TraceLevel>('class');
  const [view, setView] = useState<'graph' | 'chains'>('graph');
  const [trace, setTrace] = useState<Trace>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();

  useEffect(() => {
    setError(undefined);
    setSelected(undefined);
    api.trace(scanId, endpointId, level).then(setTrace, e => setError(e.message));
  }, [scanId, endpointId, level]);

  const node = useMemo(() => trace?.nodes.find(n => n.id === selected), [trace, selected]);
  const edgesOfNode = useMemo(() => (trace && selected ? trace.edges.filter(e => e.source === selected || e.target === selected) : []), [trace, selected]);

  if (error) return <div className="error">{error}</div>;
  if (!trace || trace.endpoint.id !== endpointId) return <div className="empty">Loading trace…</div>;
  const ep = trace.endpoint;
  const up = trace.chains.filter(c => c.direction === 'upstream');
  const down = trace.chains.filter(c => c.direction === 'downstream');
  const rootId = `ep:${ep.id}`;

  return (
    <div className="trace">
      <div className="trace-head">
        <div>
          <div className="trace-title">
            <MethodBadge method={ep.method} /> <span className="mono">{ep.path}</span>
          </div>
          <div className="muted small">
            {ep.service} · {ep.className.split('.').pop()}.{ep.methodName}() ·{' '}
            {ep.ref.url ? (
              <a href={ep.ref.url} target="_blank" rel="noreferrer">
                {ep.ref.file}:{ep.ref.line}
              </a>
            ) : (
              <span className="mono">
                {ep.ref.file}:{ep.ref.line}
              </span>
            )}
          </div>
        </div>
        <div className="toolbar">
          <div className="seg">
            {(['service', 'class', 'method'] as const).map(l => (
              <button key={l} className={level === l ? 'on' : ''} onClick={() => setLevel(l)}>
                {l}
              </button>
            ))}
          </div>
          <div className="seg">
            {(['graph', 'chains'] as const).map(v => (
              <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="stats">
        <Stat label="Upstream services" items={trace.stats.upstreamServices} />
        <Stat label="Downstream services" items={trace.stats.downstreamServices} />
        <Stat label="Tables" items={trace.stats.tables} />
        <Stat label="Topics" items={trace.stats.topics} />
        <Stat label="External systems" items={trace.stats.externals} />
      </div>

      {view === 'graph' ? (
        <div className="graph-wrap">
          <div className="graph-area">
            <div className="lane-hint">
              <span>⟵ upstream (callers)</span>
              <span>downstream (dependencies) ⟶</span>
            </div>
            <Graph nodes={trace.nodes} edges={trace.edges} rootId={rootId} selected={selected} onSelect={setSelected} />
          </div>
          {node && (
            <aside className="details">
              <div className="details-head">
                <span className="gtag" style={{ background: KIND_STYLE[node.kind]?.border }}>{node.kind}</span>
                <button className="link" onClick={() => setSelected(undefined)}>
                  ✕
                </button>
              </div>
              <h3 className="mono">{node.label}</h3>
              {node.service && <div className="kv"><b>Service</b> {node.service}</div>}
              {node.className && <div className="kv"><b>Class</b> <span className="mono">{node.className}</span></div>}
              {node.detail && <div className="kv"><b>Detail</b> {node.detail}</div>}
              <div className="kv"><b>Side</b> {node.side}</div>
              {node.ref && (
                <div className="kv">
                  <b>Source</b>{' '}
                  {node.ref.url ? <a href={node.ref.url} target="_blank" rel="noreferrer">{node.ref.file}:{node.ref.line}</a> : <span className="mono">{node.ref.file}:{node.ref.line}</span>}
                </div>
              )}
              {edgesOfNode.length > 0 && (
                <>
                  <h4>Connections</h4>
                  <ul className="conn">
                    {edgesOfNode.map(e => {
                      const other = trace.nodes.find(n => n.id === (e.source === selected ? e.target : e.source));
                      return (
                        <li key={e.id}>
                          <span className="muted">{e.source === selected ? '→' : '←'} {e.kind}</span>{' '}
                          <button className="link" onClick={() => setSelected(other?.id)}>{other?.label}</button>
                          {e.label && <div className="small muted mono">{e.label}</div>}
                          {e.confidence !== 'high' && <div className="small warn">{e.confidence} confidence</div>}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </aside>
          )}
        </div>
      ) : (
        <div className="chains">
          <ChainTable title={`Upstream chains (${up.length})`} chains={up} empty="No callers found: this endpoint is an entry point (called by external clients or UIs outside the scanned repos)." />
          <ChainTable title={`Downstream chains (${down.length})`} chains={down} empty="No downstream dependencies found." />
        </div>
      )}
      {view === 'graph' && <Legend />}
    </div>
  );
}

function Stat({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="stat" title={items.join('\n')}>
      <div className="stat-n">{items.length}</div>
      <div className="stat-l">{label}</div>
      <div className="stat-items">{items.slice(0, 4).join(', ')}{items.length > 4 ? '…' : ''}</div>
    </div>
  );
}

function ChainTable({ title, chains, empty }: { title: string; chains: Trace['chains']; empty: string }) {
  return (
    <div className="chain-block">
      <h3>{title}</h3>
      {!chains.length && <div className="muted">{empty}</div>}
      <ol>
        {chains.map((c, i) => (
          <li key={i} className="chain">
            {c.steps.map((s, j) => (
              <span key={j}>
                {j > 0 && <span className="arrow">→</span>}
                <span className="step" style={{ borderColor: KIND_STYLE[s.kind]?.border, background: KIND_STYLE[s.kind]?.bg }} title={s.service}>
                  {s.label}
                </span>
              </span>
            ))}
          </li>
        ))}
      </ol>
    </div>
  );
}
