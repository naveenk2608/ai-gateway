// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me, Range } from '../api.js';
import { AppShell } from './AppShell.js';
import { RangePicker } from './RangePicker.js';
import { ThemeToggle } from './ThemeToggle.js';
import { initials } from './UserMenu.js';

const me: Me = {
  user: { id: 'u1', email: 'ada.lovelace@example.com' },
  projects: [
    { id: 'p1', name: 'Demo project', role: 'owner' },
    { id: 'p2', name: 'Other project', role: 'viewer' },
  ],
};

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(Response.json({ status: 'ready', checks: { postgres: { status: 'ok' } } })),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function shell(overrides: Partial<Parameters<typeof AppShell>[0]> = {}) {
  const props = {
    page: 'overview' as const,
    me,
    projectId: 'p1',
    onProjectChange: vi.fn(),
    role: 'owner' as const,
    range: '24h' as Range | null,
    onRangeChange: vi.fn(),
    onLogout: vi.fn(),
    loggingOut: false,
    ...overrides,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AppShell {...props}>
        <p>page content</p>
      </AppShell>
    </QueryClientProvider>,
  );
  return props;
}

describe('initials', () => {
  it('takes two letters from the name before the @', () => {
    expect(initials('ada.lovelace@example.com')).toBe('AL');
    expect(initials('admin@example.com')).toBe('AD');
    expect(initials('@example.com')).toBe('?');
  });
});

describe('RangePicker', () => {
  function Picker() {
    const [range, setRange] = useState<Range>('24h');
    return <RangePicker value={range} onChange={setRange} />;
  }

  it('is a radio group that arrow keys move through, wrapping at the ends', () => {
    render(<Picker />);
    const checked = () =>
      screen.getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true');
    expect(checked()?.textContent).toBe('24h');
    fireEvent.keyDown(checked()!, { key: 'ArrowRight' });
    expect(checked()?.textContent).toBe('7d');
    fireEvent.keyDown(checked()!, { key: 'ArrowRight' });
    fireEvent.keyDown(checked()!, { key: 'ArrowRight' });
    expect(checked()?.textContent).toBe('1h');
    fireEvent.keyDown(checked()!, { key: 'ArrowLeft' });
    expect(checked()?.textContent).toBe('30d');
    expect(document.activeElement).toBe(checked());
    // Only the checked option is in the tab order.
    expect(screen.getAllByRole('radio').filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });
});

describe('ThemeToggle', () => {
  it('switches the theme on <html> and remembers it', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('ai-gateway.theme')).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('ai-gateway.theme')).toBe('dark');
  });
});

describe('AppShell', () => {
  it('shows the page title, its content and links to every page', () => {
    shell({ page: 'cost' });
    expect(screen.getByRole('heading', { level: 1, name: 'Cost' })).toBeTruthy();
    expect(screen.getByText('page content')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(nav).getAllByRole('link')).toHaveLength(8);
    expect(within(nav).getByRole('link', { name: 'Cost' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Infrastructure' }).getAttribute('href')).toBe(
      '#infra',
    );
  });

  it('collapses the sidebar to icons and remembers it', () => {
    shell();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(document.querySelector('.app-shell')?.getAttribute('data-sidebar')).toBe('collapsed');
    expect(localStorage.getItem('ai-gateway.sidebar')).toBe('collapsed');
    // Names stay available to assistive technology.
    expect(screen.getByRole('link', { name: 'Requests' })).toBeTruthy();
    cleanup();
    shell();
    expect(document.querySelector('.app-shell')?.getAttribute('data-sidebar')).toBe('collapsed');
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
  });

  it('switches projects and ranges, and hides the range where a page has none', () => {
    const props = shell();
    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), {
      target: { value: 'p2' },
    });
    expect(props.onProjectChange).toHaveBeenCalledWith('p2');
    fireEvent.click(screen.getByRole('radio', { name: '7d' }));
    expect(props.onRangeChange).toHaveBeenCalledWith('7d');
    cleanup();
    shell({ page: 'settings', range: null });
    expect(screen.queryByRole('radiogroup', { name: 'Time range' })).toBeNull();
  });

  it('opens the account menu with the email, role and Log out; Escape closes it', () => {
    const props = shell();
    const account = screen.getByRole('button', { name: 'Account' });
    fireEvent.click(account);
    expect(account.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('ada.lovelace@example.com')).toBeTruthy();
    expect(screen.getByText('owner of this project')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(props.onLogout).toHaveBeenCalledOnce();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
    expect(document.activeElement).toBe(account);
  });

  it('opens the navigation drawer, keeps focus in it, and closes on Escape', () => {
    shell();
    const open = screen.getByRole('button', { name: 'Open navigation' });
    open.focus();
    fireEvent.click(open);
    const drawer = screen.getByRole('dialog', { name: 'Navigation' });
    expect(within(drawer).getAllByRole('link')).toHaveLength(8);
    const close = within(drawer).getByRole('button', { name: 'Close navigation' });
    expect(document.activeElement).toBe(close);
    // Shift+Tab from the first control wraps to the last one inside the drawer.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(drawer.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it('shows the gateway status from /ready', async () => {
    shell();
    expect((await screen.findAllByText('Gateway ready')).length).toBeGreaterThan(0);
  });
});
