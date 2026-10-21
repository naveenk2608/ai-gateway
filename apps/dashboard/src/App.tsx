import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useState } from 'react';
import { api, isUnauthenticated, type AnalyticsFilters, type Me, type Range } from './api.js';
import { Cost } from './pages/Cost.js';
import { Infrastructure } from './pages/Infrastructure.js';
import { Login } from './pages/Login.js';
import { Models } from './pages/Models.js';
import { Overview } from './pages/Overview.js';
import { Reliability } from './pages/Reliability.js';
import { Requests } from './pages/Requests.js';
import { Security } from './pages/Security.js';
import { NewProject, Settings } from './pages/Settings.js';
import { AppShell } from './shell/AppShell.js';
import { Brand } from './shell/Brand.js';
import { pageInfo, usePage } from './shell/nav.js';
import { Empty, ErrorState, Loading } from './ui/states.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A missing session is an answer, not a failure to retry.
      retry: (count, error) => !isUnauthenticated(error) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

function Dashboard({ me }: { me: Me }) {
  const client = useQueryClient();
  const page = usePage();
  const [projectId, setProjectId] = useState(me.projects[0]?.id ?? '');
  const [range, setRange] = useState<Range>('24h');
  const filters: AnalyticsFilters = { range };
  const project = me.projects.find((p) => p.id === projectId) ?? me.projects[0];
  const logout = useMutation({
    mutationFn: () => api('/admin/auth/logout', { method: 'POST' }),
    onSettled: () => client.resetQueries(),
  });

  return (
    <AppShell
      page={page}
      me={me}
      projectId={project?.id ?? null}
      onProjectChange={setProjectId}
      role={project?.role ?? null}
      range={project && pageInfo(page).ranged ? range : null}
      onRangeChange={setRange}
      onLogout={() => logout.mutate()}
      loggingOut={logout.isPending}
      heading={
        project
          ? undefined
          : { title: 'Welcome', description: 'Create a project to start using the gateway.' }
      }
    >
      {!project ? (
        <>
          <Empty>
            You are not a member of any project yet. Ask a project owner to add you, or create one.
          </Empty>
          <NewProject />
        </>
      ) : (
        <>
          {page === 'overview' && <Overview projectId={project.id} filters={filters} />}
          {page === 'requests' && <Requests key={project.id} projectId={project.id} />}
          {page === 'cost' && <Cost projectId={project.id} filters={filters} />}
          {page === 'models' && <Models projectId={project.id} filters={filters} />}
          {page === 'reliability' && <Reliability projectId={project.id} filters={filters} />}
          {page === 'security' && <Security projectId={project.id} filters={filters} />}
          {page === 'infra' && <Infrastructure projectId={project.id} filters={filters} />}
          {page === 'settings' && (
            <Settings key={project.id} projectId={project.id} userId={me.user.id} />
          )}
        </>
      )}
    </AppShell>
  );
}

function Shell() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: ({ signal }) => api<Me>('/admin/me', { signal }),
  });
  if (me.isPending || me.isError) {
    if (me.isError && isUnauthenticated(me.error)) return <Login />;
    return (
      <main className="auth">
        <div className="auth-card">
          <div className="auth-brand">
            <Brand />
          </div>
          {me.isPending ? (
            <Loading what="your session" />
          ) : (
            <ErrorState error={me.error} retry={() => void me.refetch()} />
          )}
        </div>
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
