// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyResponses, PROJECT_ID, sampleResponses } from '../../e2e/fixtures.js';
import type { AnalyticsFilters, Role } from '../api.js';
import { Cost } from './Cost.js';
import { Infrastructure } from './Infrastructure.js';
import { Models } from './Models.js';
import { Overview } from './Overview.js';
import { Reliability } from './Reliability.js';
import { Requests } from './Requests.js';
import { Security } from './Security.js';
import { Settings } from './Settings.js';

beforeAll(() => {
  // Recharts measures its container; jsdom has no layout, so give it a fixed size.
  globalThis.ResizeObserver = class {
    readonly #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }
    observe(target: Element) {
      this.#callback(
        [{ target, contentRect: { width: 600, height: 220 } } as ResizeObserverEntry],
        this,
      );
    }
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Mode = 'loading' | 'error' | 'empty' | 'data';

/** Answers the admin API from fixtures; `loading` never answers, `error` fails every call. */
function stubApi(mode: Mode, role: Role = 'owner') {
  const responses = mode === 'data' ? sampleResponses(role) : emptyResponses(role);
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    if (mode === 'loading') return new Promise<Response>(() => undefined);
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'http://dashboard.test');
    const path = url.pathname;
    if (mode === 'error') {
      return Promise.resolve(
        Response.json(
          { error: { code: 'internal_error', message: 'The gateway failed (test).' } },
          { status: 500 },
        ),
      );
    }
    const body = responses[path];
    return Promise.resolve(
      body === undefined
        ? Response.json({ error: { code: 'not_found', message: path } }, { status: 404 })
        : Response.json(body),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function show(page: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
}

const filters: AnalyticsFilters = { range: '24h' };

const pages: { name: string; page: () => ReactElement; empty: RegExp; data: RegExp }[] = [
  {
    name: 'Overview',
    page: () => <Overview projectId={PROJECT_ID} filters={filters} />,
    empty: /No requests in the last 24h/,
    data: /mock-failover/,
  },
  {
    name: 'Requests',
    page: () => <Requests projectId={PROJECT_ID} filters={filters} />,
    empty: /No requests in the last 24h/,
    data: /mock-failover/,
  },
  {
    name: 'Cost',
    page: () => <Cost projectId={PROJECT_ID} filters={filters} />,
    empty: /nothing was spent/,
    data: /over 80% used/,
  },
  {
    name: 'Models',
    page: () => <Models projectId={PROJECT_ID} filters={filters} />,
    empty: /No requests reached a model/,
    data: /say nothing about the\s+quality/,
  },
  {
    name: 'Reliability',
    page: () => <Reliability projectId={PROJECT_ID} filters={filters} />,
    empty: /No requests in the last 24h/,
    data: /upstream_error/,
  },
  {
    name: 'Security',
    page: () => <Security projectId={PROJECT_ID} filters={filters} />,
    empty: /No requests were rejected/,
    data: /rpm_limit_exceeded/,
  },
  {
    name: 'Infrastructure',
    page: () => <Infrastructure projectId={PROJECT_ID} filters={filters} />,
    empty: /The pipeline is idle/,
    data: /Unread events/,
  },
  {
    name: 'Settings',
    page: () => <Settings projectId={PROJECT_ID} userId="u" tab="keys" />,
    empty: /This project has no API keys yet/,
    data: /backend/,
  },
];

describe.each(pages)('$name page', ({ page, empty, data }) => {
  it('shows a loading state while the API has not answered', async () => {
    stubApi('loading');
    show(page());
    expect((await screen.findAllByText(/Loading/)).length).toBeGreaterThan(0);
  });

  it('shows the error with a retry when the API fails', async () => {
    stubApi('error');
    show(page());
    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0]?.textContent).toContain('The gateway failed (test).');
    expect(within(alerts[0]!).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('shows an empty state on an empty database', async () => {
    stubApi('empty');
    show(page());
    expect((await screen.findAllByText(empty)).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('alert')).toEqual([]);
  });

  it('shows the data the API returned', async () => {
    stubApi('data');
    show(page());
    expect((await screen.findAllByText(data)).length).toBeGreaterThan(0);
  });
});

describe('Overview KPI cards', () => {
  const page = () => <Overview projectId={PROJECT_ID} filters={filters} />;
  const card = (name: string) => screen.getByRole('region', { name });

  it('shows requests, error rate, p95 latency, cost and cache-hit ratio from the totals', async () => {
    stubApi('data');
    show(page());
    // The cards are there with skeletons while the API answers.
    expect(await within(card('Requests')).findByText('120')).toBeTruthy();
    expect(within(card('Error rate')).getByText('7.3%')).toBeTruthy();
    expect(within(card('Latency p95')).getByText('2.10 s')).toBeTruthy();
    expect(within(card('Cost')).getByText('$0.18')).toBeTruthy();
    expect(within(card('Cache-hit ratio')).getByText('4.5%')).toBeTruthy();
  });

  it('compares nothing with a previous period: the API returns one window', async () => {
    stubApi('data');
    show(page());
    await within(card('Requests')).findByText('120');
    expect(screen.queryByText(/previous|vs\.? last|[↑↓▲▼]/i)).toBeNull();
  });

  it('draws requests, error rate and cost from API series; p95 and cache-hit have none', async () => {
    stubApi('data');
    show(page());
    expect(
      await within(card('Cost')).findByRole('img', {
        name: /^Cost per 15 min: low/,
      }),
    ).toBeTruthy();
    await within(card('Requests')).findByText('120');
    expect(
      within(card('Requests')).getByRole('img', { name: /^Requests per 15 min: low/ }),
    ).toBeTruthy();
    expect(
      within(card('Error rate')).getByRole('img', { name: /^Error rate per 15 min: low/ }),
    ).toBeTruthy();
    for (const name of ['Latency p95', 'Cache-hit ratio']) {
      expect(within(card(name)).getByText('no trend data')).toBeTruthy();
      expect(within(card(name)).queryByRole('img')).toBeNull();
    }
  });

  it('has no error-rate line when no interval admitted a request', async () => {
    stubApi('empty');
    show(page());
    const errors = card('Error rate');
    expect(await within(errors).findByText('no admitted requests')).toBeTruthy();
    expect(within(errors).queryByRole('img')).toBeNull();
    expect(within(card('Requests')).getByText('0')).toBeTruthy();
  });

  it('shows the month spend against the budget and the gateway readiness', async () => {
    stubApi('data');
    show(page());
    expect(await screen.findByText('Spend in 2026-10 (UTC)')).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Budget used' })).toBeTruthy();
    expect(await screen.findByText('Gateway readiness')).toBeTruthy();
  });
});

describe('Requests page', () => {
  const page = (range: AnalyticsFilters['range'] = '24h') => (
    <Requests projectId={PROJECT_ID} filters={{ range }} />
  );

  it('takes its range from the top bar and keeps its other filters', async () => {
    const fetchMock = stubApi('data');
    show(page('7d'));
    await screen.findByText('mock-failover');
    const form = screen.getByRole('form', { name: 'Filters' });
    expect(within(form).queryByRole('combobox', { name: 'Range' })).toBeNull();
    for (const name of ['Status', 'API key']) {
      expect(within(form).getByRole('combobox', { name })).toBeTruthy();
    }
    for (const name of ['Model', 'Provider']) {
      expect(within(form).getByRole('textbox', { name })).toBeTruthy();
    }
    // The API client always calls fetch with a path string.
    const urls = fetchMock.mock.calls.map(([input]) => input as string);
    expect(
      urls.some((u) => u.includes('/admin/analytics/requests?') && u.includes('range=7d')),
    ).toBe(true);
  });

  it('shows each request in a dense row with a status badge, its ID and a latency bar', async () => {
    stubApi('data');
    show(page());
    const row = (await screen.findByText('mock-failover')).closest('tr')!;
    expect(within(row).getByText('200 success')).toBeTruthy();
    const id = within(row).getByRole('button', { name: '…000000cc' });
    expect(id.getAttribute('title')).toBe('0192f5a0-0000-7000-8000-0000000000cc');
    expect(within(row).getByText('812 ms')).toBeTruthy();
    // The slowest request on the page fills its bar.
    expect(row.querySelector<HTMLElement>('.latency-track > span')?.style.width).toBe('100%');
  });

  it('opens a side panel with first-token time, attempt timings and routing history', async () => {
    stubApi('data');
    show(page());
    fireEvent.click(await screen.findByText('mock-failover'));
    const panel = await screen.findByRole('dialog', { name: 'Request detail' });
    expect(await within(panel).findByText('238 ms')).toBeTruthy();
    expect(within(panel).getByText('time to first token')).toBeTruthy();
    expect(within(panel).getByRole('heading', { name: 'Attempt timings' })).toBeTruthy();
    expect(within(panel).getByText('12 ms')).toBeTruthy();
    expect(within(panel).getByText('790 ms · first token 226 ms')).toBeTruthy();
    expect(within(panel).getByRole('heading', { name: 'Routing history' })).toBeTruthy();
    expect(
      within(panel).getByText('priority 2 of 2; fallback after mock-error failed (server_error)'),
    ).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Request detail' })).toBeNull();
  });

  it('shows the error with a retry when the request detail fails', async () => {
    const fetchMock = stubApi('data');
    show(page());
    const row = await screen.findByText('mock-failover');
    // The list has loaded; from here every call fails, the detail included.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        Response.json(
          { error: { code: 'internal_error', message: 'Detail failed (test).' } },
          { status: 500 },
        ),
      ),
    );
    fireEvent.click(row);
    const panel = await screen.findByRole('dialog', { name: 'Request detail' });
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain('Detail failed (test).');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('Cost page', () => {
  const page = () => <Cost projectId={PROJECT_ID} filters={filters} />;
  const card = (name: string) => screen.getByRole('region', { name });

  it('shows spend, cost per request, tokens and the projection in KPI cards', async () => {
    stubApi('data');
    show(page());
    expect(await within(card('Spend')).findByText('$0.18')).toBeTruthy();
    expect(within(card('Spend')).getByRole('img', { name: /^Spend per 15 min: low/ })).toBeTruthy();
    expect(within(card('Cost per request')).getByText('$0.001533')).toBeTruthy();
    expect(within(card('Tokens')).getByText('52,000')).toBeTruthy();
    expect(within(card('Tokens')).getByText('40,000 in · 12,000 out')).toBeTruthy();
    expect(within(card('Projected this month')).getByText('$6.10')).toBeTruthy();
    expect(within(card('Projected this month')).getByText(/from 12 days of data/)).toBeTruthy();
  });

  it('says the projection needs more data instead of showing a number', async () => {
    stubApi('empty');
    show(page());
    const projection = card('Projected this month');
    expect(await within(projection).findByText('not enough data')).toBeTruthy();
    expect(within(projection).getByText(/needs 7 full days of data; there are 0/)).toBeTruthy();
    expect(within(card('Cost per request')).getByText('—')).toBeTruthy();
  });

  it('draws spend by model as shares of the total, and each breakdown with its share', async () => {
    stubApi('data');
    show(page());
    const donut = await screen.findByRole('figure', { name: 'Share of spend by model' });
    const legend = within(donut).getByRole('list');
    expect(within(legend).getByText('mock-1')).toBeTruthy();
    expect(within(legend).getByText('100.0%')).toBeTruthy();
    for (const title of ['By project', 'By API key', 'By provider', 'By model']) {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    }
    const keyRow = screen.getAllByText('backend')[0]!.closest('tr')!;
    expect(within(keyRow).getByText('120')).toBeTruthy();
    expect(within(keyRow).getByText('100.0%')).toBeTruthy();
  });

  it('shows each budget as a meter with its alert', async () => {
    stubApi('data');
    show(page());
    const meter = await screen.findByRole('meter', { name: 'Budget used by Demo project' });
    expect(meter.getAttribute('aria-valuenow')).toBe('84');
    expect(meter.className).toContain('tone-warning');
    const tile = screen.getByRole('group', { name: 'Budget of Demo project' });
    expect(within(tile).getByText('over 80% used')).toBeTruthy();
    expect(within(tile).getByText('84.0% used')).toBeTruthy();
  });

  it('compares nothing with a previous period', async () => {
    stubApi('data');
    show(page());
    await within(card('Spend')).findByText('$0.18');
    expect(screen.queryByText(/previous|vs\.? last|[↑↓▲▼]/i)).toBeNull();
  });
});

describe('Models page', () => {
  const page = () => <Models projectId={PROJECT_ID} filters={filters} />;

  it('keeps the note that speed and cost say nothing about answer quality', async () => {
    stubApi('data');
    show(page());
    const note = await screen.findByRole('note');
    expect(note.textContent).toMatch(/say nothing about the quality of the answers/);
  });

  it('charts p50 and p95 latency and compares deployments in a table', async () => {
    stubApi('data');
    show(page());
    expect(
      await screen.findByRole('figure', { name: 'Latency p50 and p95 per model and deployment' }),
    ).toBeTruthy();
    const row = (await screen.findByText('mock-1')).closest('tr')!;
    for (const value of ['420 ms', '2.10 s', '150 ms / 600 ms', '42.5', '7.3%', '0.02']) {
      expect(within(row).getByText(value)).toBeTruthy();
    }
    // The rejected-only row (no deployment) is not compared.
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });

  it('shows each deployment with its breaker state and uptime as not measured', async () => {
    stubApi('data');
    show(page());
    const failing = await screen.findByRole('group', { name: 'mock-error' });
    expect(await within(failing).findByText('Breaker open')).toBeTruthy();
    expect(
      within(screen.getByRole('group', { name: 'mock' })).getByText('never tripped'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('group', { name: 'hosted-small' })).getByText('disabled'),
    ).toBeTruthy();
    expect(screen.getAllByText('not measured')).toHaveLength(3);
    expect(screen.queryByText(/%\s*uptime|uptime\s*\d/i)).toBeNull();
  });
});

describe('Infrastructure instance card', () => {
  const page = () => <Infrastructure projectId={PROJECT_ID} filters={filters} />;

  it('shows what the answering instance measured', async () => {
    stubApi('data');
    show(page());
    expect(await screen.findByText('86.4 MiB')).toBeTruthy();
    expect(screen.getByText('This gateway instance')).toBeTruthy();
    expect(screen.getByText('4.2%')).toBeTruthy();
    expect(screen.getByText('12.5 ms')).toBeTruthy();
    expect(screen.queryByText(/not measured yet/)).toBeNull();
  });

  it('says CPU and event-loop delay are not measured on a first reading', async () => {
    stubApi('empty');
    show(page());
    expect((await screen.findAllByText(/not measured yet: needs a second reading/)).length).toBe(2);
  });
});

describe('Reliability page', () => {
  const page = () => <Reliability projectId={PROJECT_ID} filters={filters} />;
  const card = (name: string) => screen.getByRole('region', { name });

  it('shows failures, retries, fallbacks and attempts with lines from the API series', async () => {
    stubApi('data');
    show(page());
    expect(await within(card('Failed')).findByText('8')).toBeTruthy();
    expect(within(card('Failed')).getByText('7.3% of admitted requests')).toBeTruthy();
    for (const [name, line] of [
      ['Failed', /^Failed requests per 15 min: low/],
      ['Retries', /^Retries per 15 min: low/],
      ['Fallbacks', /^Fallbacks per 15 min: low/],
    ] as const) {
      expect(within(card(name)).getByRole('img', { name: line })).toBeTruthy();
    }
    expect(within(card('Upstream attempts')).getByText('125')).toBeTruthy();
  });

  it('shows each breaker per instance and each deployment in a table', async () => {
    stubApi('data');
    show(page());
    const breaker = await screen.findByRole('group', { name: 'mock-error' });
    expect(within(breaker).getByText('open')).toBeTruthy();
    expect(within(breaker).getByText('5 consecutive failures')).toBeTruthy();
    const row = screen.getByText('110').closest('tr')!;
    expect(within(row).getByText('7.3%')).toBeTruthy();
  });
});

describe('Security page', () => {
  const page = () => <Security projectId={PROJECT_ID} filters={filters} />;
  const card = (name: string) => screen.getByRole('region', { name });

  it('counts rejections by kind and says invalid keys are not counted', async () => {
    stubApi('data');
    show(page());
    expect(await within(card('Rejected')).findByText('10')).toBeTruthy();
    expect(
      within(card('Rejected')).getByRole('img', { name: /^Rejected per 15 min/ }),
    ).toBeTruthy();
    expect(within(card('Rate, token and concurrency limits')).getByText('7')).toBeTruthy();
    expect(within(card('Budget')).getByText('3')).toBeTruthy();
    expect(within(card('Model policy')).getByText('0')).toBeTruthy();
    expect(within(card('Invalid API keys')).getByText('not counted')).toBeTruthy();
  });

  it('shows each reason with its share of the rejections', async () => {
    stubApi('data');
    show(page());
    const row = (await screen.findByText('rpm_limit_exceeded')).closest('tr')!;
    expect(within(row).getByText('70.0%')).toBeTruthy();
    expect(within(row).getByText('Rate limit')).toBeTruthy();
  });
});

describe('Infrastructure KPI cards', () => {
  const page = () => <Infrastructure projectId={PROJECT_ID} filters={filters} />;
  const card = (name: string) => screen.getByRole('region', { name });

  it('shows worker lag, pending, dead letters and reachable dependencies as readings', async () => {
    stubApi('data');
    show(page());
    expect(await within(card('Worker lag')).findByText('3')).toBeTruthy();
    expect(within(card('Pending')).getByText('read, not stored · oldest 1 s')).toBeTruthy();
    expect(within(card('Dead letters')).getByText('0')).toBeTruthy();
    expect(within(card('Dependencies')).getByText('2 of 2')).toBeTruthy();
    expect(screen.getAllByText('current reading')).toHaveLength(4);
  });
});

describe('Settings tabs', () => {
  const settings = (tab: string | null, role: Role = 'owner') => {
    stubApi('data', role);
    return show(<Settings projectId={PROJECT_ID} userId="u" tab={tab} />);
  };

  it('has one tab per area, linked from the URL hash, and opens the project tab by default', async () => {
    settings(null);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Project',
      'Limits and budget',
      'Members',
      'API keys',
      'Routing',
    ]);
    expect(tabs.map((t) => t.getAttribute('href'))).toEqual([
      '#settings/project',
      '#settings/limits',
      '#settings/members',
      '#settings/keys',
      '#settings/routing',
    ]);
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Project');
    expect((await screen.findAllByText(/Project ID/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('tabpanel', { name: 'Project' })).toBeTruthy();
  });

  it('opens the tab in the URL and falls back to the first for an unknown one', () => {
    settings('routing');
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Routing');
    cleanup();
    settings('nope');
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Project');
  });

  it('moves between tabs with the arrow keys', () => {
    settings('members');
    fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'ArrowRight' });
    expect(window.location.hash).toBe('#settings/keys');
    fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'Home' });
    expect(window.location.hash).toBe('#settings/project');
  });

  it('shows limits as meters of the busiest minute in the last hour, and the budget spent', async () => {
    const fetchMock = stubApi('data');
    const answer = fetchMock.getMockImplementation()!;
    const minutes = Array.from({ length: 60 }, (_, i) =>
      new Date(Date.parse('2026-10-20T23:00:00Z') + i * 60_000).toISOString(),
    );
    const hour = { range: '1h', granularity: 'minute', stepSeconds: 60 };
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = new URL(input as string, 'http://dashboard.test');
      if (url.searchParams.get('range') !== '1h') return answer(input);
      const section = url.pathname.split('/').at(-1);
      const base = sampleResponses('owner')[`/admin/analytics/${section}`] as { window: object };
      const series =
        section === 'overview'
          ? minutes.map((start, i) => ({
              start,
              requests: i === 30 ? 50 : 4,
              succeeded: 4,
              failed: 0,
              rejected: i === 30 ? 5 : 0,
              canceled: 0,
            }))
          : minutes.map((start, i) => ({ start, costMicroUsd: 10, totalTokens: i * 20 }));
      return Promise.resolve(
        Response.json({ ...base, window: { ...base.window, ...hour }, series }),
      );
    });
    show(<Settings projectId={PROJECT_ID} userId="u" tab="limits" />);

    const rpm = await screen.findByRole('meter', { name: 'Requests per minute used' });
    expect(rpm.getAttribute('aria-valuenow')).toBe('75');
    const rpmTile = screen.getByRole('group', { name: 'Requests per minute' });
    expect(within(rpmTile).getByText('busiest minute in the last hour: 45')).toBeTruthy();
    // No token limit: the measurement is shown without a meter.
    const tpm = screen.getByRole('group', { name: 'Tokens per minute' });
    expect(await within(tpm).findByText('busiest minute in the last hour: 1,180')).toBeTruthy();
    expect(within(tpm).queryByRole('meter')).toBeNull();
    const concurrency = screen.getByRole('group', { name: 'Concurrent requests' });
    expect(within(concurrency).getByText('in-flight requests: not measured')).toBeTruthy();
    const budget = screen.getByRole('meter', { name: 'Monthly budget used' });
    expect(budget.getAttribute('aria-valuenow')).toBe('37');
    expect(screen.getByText('$1.84 spent in 2026-10 (UTC)')).toBeTruthy();
  });

  it('measures nothing against a limit when the series is not per minute', async () => {
    settings('limits');
    const rpmTile = await screen.findByRole('group', { name: 'Requests per minute' });
    expect(await within(rpmTile).findByText('use unavailable')).toBeTruthy();
    expect(within(rpmTile).queryByRole('meter')).toBeNull();
  });

  it('lists keys with their hint, status and last use as not tracked, and filters them', async () => {
    settings('keys');
    const row = (await screen.findByText('backend')).closest('tr')!;
    expect(within(row).getByText('gw_0123456789abcdef_…')).toBeTruthy();
    expect(within(row).getByText('active')).toBeTruthy();
    expect(within(row).getByText('not tracked')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search keys' }), {
      target: { value: 'frontend' },
    });
    expect(screen.queryByText('backend')).toBeNull();
    expect(screen.getByText('No key matches “frontend”.')).toBeTruthy();
  });
});

describe('roles in the settings page', () => {
  const mutationButtons = [
    'Save project settings',
    'Save limits and budget',
    'Add member',
    'Remove',
    'Create key',
    'Rotate',
    'Revoke',
  ];
  const mutationForms = ['Project settings', 'Limits and budget', 'Add member', 'New key'];
  /** Each tab with text it shows once its data has loaded. */
  const tabs: [string, RegExp][] = [
    ['project', /Project ID/],
    ['limits', /busiest minute|use unavailable/],
    ['members', /viewer@example\.com/],
    ['keys', /backend/],
    ['routing', /mock-1/],
  ];

  /** The buttons, named forms and role pickers on every tab, for one role. */
  async function controlsFor(role: Role) {
    stubApi('data', role);
    const buttons: (string | null)[] = [];
    const forms: (string | null)[] = [];
    const roleSelects: HTMLElement[] = [];
    for (const [tab, ready] of tabs) {
      const view = show(<Settings projectId={PROJECT_ID} userId="u" tab={tab} />);
      await screen.findAllByText(ready);
      buttons.push(...screen.queryAllByRole('button').map((b) => b.textContent));
      forms.push(...screen.queryAllByRole('form').map((f) => f.getAttribute('aria-label')));
      roleSelects.push(...screen.queryAllByRole('combobox', { name: /Role of/ }));
      view.unmount();
    }
    return { buttons, forms, roleSelects };
  }

  it('gives a viewer no control that changes the project, its limits, members or keys', async () => {
    const { buttons, forms, roleSelects } = await controlsFor('viewer');
    for (const name of mutationButtons) expect(buttons).not.toContain(name);
    for (const name of mutationForms) expect(forms).not.toContain(name);
    expect(roleSelects).toEqual([]);
  });

  it('shows a viewer the project and its allow-list as text', async () => {
    stubApi('data', 'viewer');
    show(<Settings projectId={PROJECT_ID} userId="u" tab="project" />);
    expect(await screen.findByText('every configured model')).toBeTruthy();
  });

  it('gives an admin project, limit and key controls but not member controls', async () => {
    const { buttons } = await controlsFor('admin');
    expect(buttons).toEqual(
      expect.arrayContaining([
        'Save project settings',
        'Save limits and budget',
        'Create key',
        'Rotate',
        'Revoke',
      ]),
    );
    expect(buttons).not.toContain('Add member');
    expect(buttons).not.toContain('Remove');
  });

  it('gives an owner every control', async () => {
    const { buttons, roleSelects } = await controlsFor('owner');
    expect(buttons).toEqual(expect.arrayContaining(mutationButtons));
    expect(roleSelects.length).toBeGreaterThan(0);
  });
});

describe('provider badges', () => {
  const badge = (scope: HTMLElement, name: string) =>
    within(scope)
      .getAllByTitle(name)
      .filter((el) => el.classList.contains('provider-badge'));

  it('show the provider in the request table and the request side panel', async () => {
    stubApi('data');
    show(<Requests projectId={PROJECT_ID} filters={filters} />);
    const row = (await screen.findByText('mock-failover')).closest('tr')!;
    await waitFor(() => expect(badge(row, 'Mock')).toHaveLength(1));
    fireEvent.click(row);
    const panel = await screen.findByRole('dialog', { name: 'Request detail' });
    await within(panel).findByRole('heading', { name: 'Routing history' });
    // The deployment fact, both attempt timings and both routing steps.
    expect(badge(panel, 'Mock')).toHaveLength(5);
  });

  it('show the provider on the models table and on each deployment card', async () => {
    stubApi('data');
    show(<Models projectId={PROJECT_ID} filters={filters} />);
    const row = (await screen.findByText('mock-1')).closest('tr')!;
    await waitFor(() => expect(badge(row, 'Mock')).toHaveLength(1));
    const hosted = await screen.findByRole('group', { name: 'hosted-small' });
    expect(badge(hosted, 'OpenAI-compatible')).toHaveLength(1);
    expect(badge(screen.getByRole('group', { name: 'mock' }), 'Mock')).toHaveLength(1);
  });

  it('show the provider in the cost breakdowns by provider and by model', async () => {
    stubApi('data');
    show(<Cost projectId={PROJECT_ID} filters={filters} />);
    const byProvider = (await screen.findByRole('heading', { name: 'By provider' })).closest(
      'section',
    )!;
    // The card's heading shows while it loads; the rows come with the data.
    await waitFor(() => expect(badge(byProvider, 'Mock')).toHaveLength(1));
    const byModel = screen.getByRole('heading', { name: 'By model' }).closest('section')!;
    await waitFor(() => expect(badge(byModel, 'Mock')).toHaveLength(1));
  });
});
