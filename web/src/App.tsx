import { useCallback, useEffect, useState } from 'react';
import { api, type EndpointRow, type ScanDetail, type ScanSummary, type ServiceInfo } from './api';
import { EndpointList } from './components/EndpointList';
import { ScanPanel } from './components/ScanPanel';
import { ServiceMapView } from './components/ServiceMapView';
import { TraceView } from './components/TraceView';

type Tab = 'endpoints' | 'map' | 'scan';

function readUrl() {
  const p = new URLSearchParams(location.search);
  return { scan: p.get('scan') ?? undefined, endpoint: p.get('endpoint') ?? undefined, tab: (p.get('tab') as Tab) ?? 'endpoints' };
}

export function App() {
  const init = readUrl();
  const [scans, setScans] = useState<ScanSummary[]>([]);
  const [scanId, setScanId] = useState<string | undefined>(init.scan);
  const [detail, setDetail] = useState<ScanDetail>();
  const [endpoints, setEndpoints] = useState<EndpointRow[]>([]);
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [endpointId, setEndpointId] = useState<string | undefined>(init.endpoint);
  const [tab, setTab] = useState<Tab>(init.tab);
  const [showNew, setShowNew] = useState(false);

  const refreshScans = useCallback(() => api.scans().then(list => {
    setScans(list);
    setScanId(cur => cur ?? list.find(s => s.status === 'done')?.id ?? list[0]?.id);
  }), []);

  useEffect(() => {
    void refreshScans();
  }, [refreshScans]);

  useEffect(() => {
    const p = new URLSearchParams();
    if (scanId) p.set('scan', scanId);
    if (endpointId) p.set('endpoint', endpointId);
    if (tab !== 'endpoints') p.set('tab', tab);
    history.replaceState(null, '', `?${p}`);
  }, [scanId, endpointId, tab]);

  useEffect(() => {
    if (!scanId) return;
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const poll = async () => {
      try {
        const d = await api.scan(scanId);
        if (cancelled) return;
        setDetail(d);
        if (d.status === 'running') timer = setTimeout(poll, 1000);
        else {
          void refreshScans();
          if (d.status === 'done') {
            const [eps, svcs] = await Promise.all([api.endpoints(scanId), api.services(scanId)]);
            if (cancelled) return;
            setEndpoints(eps);
            setServices(svcs);
            setEndpointId(cur => (cur && eps.some(e => e.id === cur) ? cur : eps[0]?.id));
          }
        }
      } catch {
        setDetail(undefined);
      }
    };
    setEndpoints([]);
    setServices([]);
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [scanId, refreshScans]);

  const remove = async () => {
    if (!scanId || !confirm('Delete this scan?')) return;
    await api.deleteScan(scanId);
    setScanId(undefined);
    setEndpointId(undefined);
    void refreshScans();
  };

  return (
    <div className="app">
      <header>
        <div className="brand">
          API Traceability <span className="muted small">Java / Spring microservices</span>
        </div>
        <select value={scanId ?? ''} onChange={e => { setScanId(e.target.value || undefined); setEndpointId(undefined); }}>
          {!scans.length && <option value="">No scans yet</option>}
          {scans.map(s => (
            <option key={s.id} value={s.id}>
              {s.name} · {new Date(s.createdAt).toLocaleString()} {s.status !== 'done' ? `(${s.status})` : ''}
            </option>
          ))}
        </select>
        <button className="primary" onClick={() => setShowNew(true)}>
          + New scan
        </button>
        <nav>
          {([
            ['endpoints', 'Endpoints'],
            ['map', 'Service map'],
            ['scan', 'Scan details']
          ] as const).map(([k, l]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </nav>
        {scanId && detail?.status === 'done' && (
          <a className="btn" href={api.exportUrl(scanId)}>
            Export CSV
          </a>
        )}
      </header>

      {showNew && (
        <ScanPanel
          onClose={() => setShowNew(false)}
          onStarted={id => {
            setShowNew(false);
            setScanId(id);
            setEndpointId(undefined);
            setTab('scan');
            void refreshScans();
          }}
        />
      )}

      {!scanId && <div className="empty big">Start a scan to analyse your microservices.</div>}

      {scanId && detail?.status === 'running' && tab !== 'scan' && <div className="empty big">Scanning… <Progress lines={detail.progress} /></div>}
      {scanId && detail?.status === 'failed' && tab !== 'scan' && <div className="error big">Scan failed: {detail.error}</div>}

      {scanId && detail?.status === 'done' && tab === 'endpoints' && (
        <main className="split">
          <EndpointList endpoints={endpoints} selected={endpointId} onSelect={setEndpointId} />
          <section className="main">{endpointId ? <TraceView scanId={scanId} endpointId={endpointId} /> : <div className="empty">Select an endpoint.</div>}</section>
        </main>
      )}
      {scanId && detail?.status === 'done' && tab === 'map' && (
        <main className="main pad">
          <ServiceMapView scanId={scanId} />
        </main>
      )}
      {scanId && detail && tab === 'scan' && (
        <main className="main pad scroll">
          <div className="card">
            <h2>{detail.name}</h2>
            <div className="kv"><b>Source</b> {detail.source}</div>
            <div className="kv"><b>Status</b> {detail.status}{detail.error ? ` — ${detail.error}` : ''}</div>
            <div className="kv"><b>Started</b> {new Date(detail.createdAt).toLocaleString()}</div>
            {detail.status === 'done' && <div className="kv"><b>Result</b> {detail.services} services, {detail.endpoints} endpoints</div>}
            <Progress lines={detail.progress} />
            <button className="danger" onClick={remove}>Delete scan</button>
          </div>
          {services.length > 0 && (
            <div className="card">
              <h3>Services</h3>
              <table>
                <thead>
                  <tr><th>Service</th><th>Repository</th><th>Module</th><th>Context path</th><th>Types</th><th>Endpoints</th></tr>
                </thead>
                <tbody>
                  {services.map(s => (
                    <tr key={s.name}>
                      <td>{s.name}</td>
                      <td>{s.webUrl ? <a href={s.webUrl} target="_blank" rel="noreferrer">{s.repo}</a> : s.repo}</td>
                      <td className="mono">{s.modulePath}</td>
                      <td className="mono">{s.contextPath || '/'}</td>
                      <td>{s.classCount}</td>
                      <td>{s.endpointCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {detail.warningList.length > 0 && (
            <div className="card">
              <h3>Warnings ({detail.warningList.length})</h3>
              <ul className="small">{detail.warningList.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
        </main>
      )}
    </div>
  );
}

function Progress({ lines }: { lines: string[] }) {
  return <pre className="progress">{lines.join('\n') || 'Starting…'}</pre>;
}
