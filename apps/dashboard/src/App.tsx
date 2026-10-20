import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  api,
  isUnauthenticated,
  RANGES,
  type AnalyticsFilters,
  type Me,
  type Range,
} from './api.js';
import { Cost } from './Cost.js';
import { Infrastructure } from './Infrastructure.js';
import { Login } from './Login.js';
import { Models } from './Models.js';
import { Overview } from './Overview.js';
import { Reliability } from './Reliability.js';
import { Requests } from './Requests.js';
import { Security } from './Security.js';
import { NewProject, Settings } from './Settings.js';
import { Empty, ErrorState, Loading } from './ui.js';

const TABS = {
  overview: 'Overview',
  requests: 'Requests',
  cost: 'Cost',
  models: 'Models',
  reliability: 'Reliability',
  security: 'Security',
  infra: 'Infrastructure',
  settings: 'Settings',
} as const;
type Tab = keyof typeof TABS;
/** Pages that show one time range, chosen in the toolbar. */
const RANGED: Tab[] = ['overview', 'cost', 'models', 'reliability', 'security', 'infra'];

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A missing session is an answer, not a failure to retry.
      retry: (count, error) => !isUnauthenticated(error) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

/** The tab in the URL hash, so a reload keeps the page. */
function useTab(): [Tab, (tab: Tab) => void] {
  const read = (): Tab => {
    const hash = window.location.hash.slice(1);
    return Object.hasOwn(TABS, hash) ? (hash as Tab) : 'overview';
  };
  const [tab, setTab] = useState<Tab>(read);
  useEffect(() => {
    const onHash = () => setTab(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return [tab, (next) => (window.location.hash = next)];
}

function Dashboard({ me }: { me: Me }) {
  const client = useQueryClient();
  const [tab, setTab] = useTab();
  const [projectId, setProjectId] = useState(me.projects[0]?.id ?? '');
  const [range, setRange] = useState<Range>('24h');
  const filters: AnalyticsFilters = { range };
  const project = me.projects.find((p) => p.id === projectId) ?? me.projects[0];
  const logout = useMutation({
    mutationFn: () => api('/admin/auth/logout', { method: 'POST' }),
    onSettled: () => client.resetQueries(),
  });

  return (
    <main>
      <header className="topbar">
        <h1>AI Gateway</h1>
        <div className="row">
          {me.projects.length > 0 && (
            <select
              aria-label="Project"
              value={project?.id}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {me.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.role})
                </option>
              ))}
            </select>
          )}
          <span className="muted small">{me.user.email}</span>
          <button type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Log out
          </button>
        </div>
      </header>
      {!project ? (
        <>
          <Empty>
            You are not a member of any project yet. Ask a project owner to add you, or create one.
          </Empty>
          <NewProject />
        </>
      ) : (
        <>
          <div className="toolbar">
            <nav className="tabs" aria-label="Pages">
              {(Object.keys(TABS) as Tab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={t === tab ? 'tab active' : 'tab'}
                  aria-current={t === tab ? 'page' : undefined}
                  onClick={() => setTab(t)}
                >
                  {TABS[t]}
                </button>
              ))}
            </nav>
            {RANGED.includes(tab) && (
              <label className="range">
                Range
                <select value={range} onChange={(e) => setRange(e.target.value as Range)}>
                  {RANGES.map((r) => (
                    <option key={r} value={r}>
                      last {r}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {tab === 'overview' && <Overview projectId={project.id} filters={filters} />}
          {tab === 'requests' && <Requests key={project.id} projectId={project.id} />}
          {tab === 'cost' && <Cost projectId={project.id} filters={filters} />}
          {tab === 'models' && <Models projectId={project.id} filters={filters} />}
          {tab === 'reliability' && <Reliability projectId={project.id} filters={filters} />}
          {tab === 'security' && <Security projectId={project.id} filters={filters} />}
          {tab === 'infra' && <Infrastructure projectId={project.id} filters={filters} />}
          {tab === 'settings' && (
            <Settings key={project.id} projectId={project.id} userId={me.user.id} />
          )}
        </>
      )}
    </main>
  );
}

function Shell() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: ({ signal }) => api<Me>('/admin/me', { signal }),
  });
  if (me.isPending) {
    return (
      <main className="narrow">
        <Loading what="your session" />
      </main>
    );
  }
  if (me.isError) {
    if (isUnauthenticated(me.error)) return <Login />;
    return (
      <main className="narrow">
        <ErrorState error={me.error} retry={() => void me.refetch()} />
      </main>
    );
  }
  return <Dashboard me={me.data} />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  );
}
