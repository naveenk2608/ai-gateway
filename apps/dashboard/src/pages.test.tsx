// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyResponses, PROJECT_ID, sampleResponses } from '../e2e/fixtures.js';
import type { AnalyticsFilters, Role } from './api.js';
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

/** Answers /api/... from fixtures; `loading` never answers, `error` fails every call. */
function stubApi(mode: Mode, role: Role = 'owner') {
  const responses = mode === 'data' ? sampleResponses(role) : emptyResponses(role);
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    if (mode === 'loading') return new Promise<Response>(() => undefined);
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'http://dashboard.test');
    const path = url.pathname.replace(/^\/api/, '');
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
    data: /Request rate/,
  },
  {
    name: 'Requests',
    page: () => <Requests projectId={PROJECT_ID} />,
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
    page: () => <Settings projectId={PROJECT_ID} userId="u" />,
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

describe('roles in the settings page', () => {
  const mutationButtons = [
    'Save project settings',
    'Add member',
    'Remove',
    'Create key',
    'Rotate',
    'Revoke',
  ];

  async function buttonsFor(role: Role) {
    stubApi('data', role);
    show(<Settings projectId={PROJECT_ID} userId="u" />);
    await screen.findAllByText('backend');
    await screen.findAllByText('viewer@example.com');
    return screen.getAllByRole('button').map((b) => b.textContent);
  }

  it('gives a viewer no control that changes the project, its members or its keys', async () => {
    const buttons = await buttonsFor('viewer');
    for (const name of mutationButtons) expect(buttons).not.toContain(name);
    expect(screen.queryByRole('form', { name: 'Project settings' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add member' })).toBeNull();
    expect(screen.queryAllByRole('combobox', { name: /Role of/ })).toEqual([]);
    expect(screen.getByText('every configured model')).toBeTruthy();
  });

  it('gives an admin project and key controls but not member controls', async () => {
    const buttons = await buttonsFor('admin');
    expect(buttons).toEqual(
      expect.arrayContaining(['Save project settings', 'Create key', 'Revoke']),
    );
    expect(buttons).not.toContain('Add member');
  });

  it('gives an owner every control', async () => {
    const buttons = await buttonsFor('owner');
    expect(buttons).toEqual(
      expect.arrayContaining(['Save project settings', 'Create key', 'Add member', 'Remove']),
    );
  });
});
