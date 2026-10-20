import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, isUnauthenticated, type Me } from './api.js';
import { ApiKeys } from './ApiKeys.js';
import { Login } from './Login.js';
import { Overview } from './Overview.js';
import { Requests } from './Requests.js';
import { Empty, ErrorState, Loading } from './ui.js';

const TABS = { overview: 'Overview', requests: 'Requests', keys: 'API keys' } as const;
type Tab = keyof typeof TABS;

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
    return hash in TABS ? (hash as Tab) : 'overview';
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
        <Empty>You are not a member of any project yet. Ask a project owner to add you.</Empty>
      ) : (
        <>
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
          {tab === 'overview' && <Overview projectId={project.id} />}
          {tab === 'requests' && <Requests key={project.id} projectId={project.id} />}
          {tab === 'keys' && <ApiKeys projectId={project.id} role={project.role} />}
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
