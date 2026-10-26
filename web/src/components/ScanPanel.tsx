import { useEffect, useState } from 'react';
import { api } from '../api';

type Kind = 'bitbucket-cloud' | 'bitbucket-server' | 'local';

export function ScanPanel({ onStarted, onClose }: { onStarted: (id: string) => void; onClose: () => void }) {
  const [kind, setKind] = useState<Kind>('bitbucket-cloud');
  const [cfg, setCfg] = useState<{ localRoots: string[]; bitbucketEnvAuth: boolean }>();
  const [f, setF] = useState({ name: '', workspace: '', baseUrl: '', projectKey: '', repos: '', repoFilter: '', branch: '', token: '', username: '', password: '', paths: '' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    api.config().then(c => {
      setCfg(c);
      setF(prev => ({ ...prev, paths: prev.paths || c.localRoots[0] || '' }));
    });
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const list = (s: string) => s.split(/[,\n]/).map(x => x.trim()).filter(Boolean);
      const auth = f.token ? { token: f.token } : f.username && f.password ? { username: f.username, password: f.password } : undefined;
      const source =
        kind === 'local'
          ? { type: 'local', paths: list(f.paths) }
          : {
              type: kind,
              workspace: kind === 'bitbucket-cloud' ? f.workspace : undefined,
              baseUrl: kind === 'bitbucket-server' ? f.baseUrl : undefined,
              projectKey: f.projectKey || undefined,
              repos: list(f.repos),
              repoFilter: f.repoFilter || undefined,
              branch: f.branch || undefined,
              auth
            };
      const s = await api.startScan(source, f.name || undefined);
      onStarted(s.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="modal" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <h2>New scan</h2>
        <div className="seg wide">
          {([
            ['bitbucket-cloud', 'Bitbucket Cloud'],
            ['bitbucket-server', 'Bitbucket Data Center'],
            ['local', 'Local folders']
          ] as const).map(([k, l]) => (
            <button type="button" key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
              {l}
            </button>
          ))}
        </div>
        <label>
          Name <input value={f.name} onChange={set('name')} placeholder="optional" />
        </label>
        {kind === 'bitbucket-cloud' && (
          <label>
            Workspace* <input required value={f.workspace} onChange={set('workspace')} placeholder="my-workspace" />
          </label>
        )}
        {kind === 'bitbucket-server' && (
          <label>
            Base URL* <input required value={f.baseUrl} onChange={set('baseUrl')} placeholder="https://bitbucket.mycompany.com" />
          </label>
        )}
        {kind !== 'local' && (
          <>
            <div className="row">
              <label>
                Project key{kind === 'bitbucket-server' ? '*' : ''} <input required={kind === 'bitbucket-server'} value={f.projectKey} onChange={set('projectKey')} placeholder="PAY" />
              </label>
              <label>
                Branch <input value={f.branch} onChange={set('branch')} placeholder="default branch" />
              </label>
            </div>
            <div className="row">
              <label>
                Repositories <input value={f.repos} onChange={set('repos')} placeholder="order-service, inventory-service (blank = all)" />
              </label>
              <label>
                Repo name regex <input value={f.repoFilter} onChange={set('repoFilter')} placeholder="-service$" />
              </label>
            </div>
            <fieldset>
              <legend>Credentials (read access)</legend>
              {cfg?.bitbucketEnvAuth && <div className="small ok">Server credentials are configured; leave blank to use them.</div>}
              <label>
                Access token <input type="password" autoComplete="off" value={f.token} onChange={set('token')} placeholder="workspace / project / repository / HTTP access token" />
              </label>
              <div className="row">
                <label>
                  or username <input autoComplete="off" value={f.username} onChange={set('username')} />
                </label>
                <label>
                  app password / API token <input type="password" autoComplete="off" value={f.password} onChange={set('password')} />
                </label>
              </div>
              <div className="small muted">Credentials are used only for this scan and are never stored.</div>
            </fieldset>
          </>
        )}
        {kind === 'local' && (
          <label>
            Folders* (comma separated)
            <input required value={f.paths} onChange={set('paths')} />
            <span className="small muted">Allowed roots: {cfg?.localRoots.join(', ')}</span>
          </label>
        )}
        {error && <div className="error">{error}</div>}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            Start scan
          </button>
        </div>
      </form>
    </div>
  );
}
