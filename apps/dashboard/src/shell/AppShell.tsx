import { useRef, useState, type ReactNode } from 'react';
import type { Me, Range, Role } from '../api.js';
import { MobileNav } from './MobileNav.js';
import { pageInfo, type PageId } from './nav.js';
import { readPreference, writePreference } from './preferences.js';
import { Sidebar } from './Sidebar.js';
import { Topbar } from './Topbar.js';

const SIDEBAR_KEY = 'ai-gateway.sidebar';

/**
 * The layout around every page (ADR 020): sidebar, top bar, the page's header and its content.
 * Below 768 px the sidebar gives way to a drawer opened from the top bar.
 */
export function AppShell({
  page,
  me,
  projectId,
  onProjectChange,
  role,
  range,
  onRangeChange,
  onLogout,
  loggingOut,
  heading,
  children,
}: {
  page: PageId;
  me: Me;
  projectId: string | null;
  onProjectChange: (projectId: string) => void;
  role: Role | null;
  range: Range | null;
  onRangeChange: (range: Range) => void;
  onLogout: () => void;
  loggingOut: boolean;
  /** Replaces the page's title and description (e.g. before the user has a project). */
  heading?: { title: string; description: string };
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => readPreference(SIDEBAR_KEY) === 'collapsed');
  const [navOpen, setNavOpen] = useState(false);
  const main = useRef<HTMLElement>(null);
  const info = pageInfo(page);
  const { title, description } = heading ?? info;
  const Icon = info.icon;

  const toggleSidebar = () => {
    const next = !collapsed;
    setCollapsed(next);
    writePreference(SIDEBAR_KEY, next ? 'collapsed' : 'expanded');
  };

  return (
    <div className="app-shell" data-sidebar={collapsed ? 'collapsed' : 'expanded'}>
      <button type="button" className="skip-link" onClick={() => main.current?.focus()}>
        Skip to content
      </button>
      <Sidebar current={page} collapsed={collapsed} onToggle={toggleSidebar} />
      <div className="app-main">
        <Topbar
          me={me}
          projectId={projectId}
          onProjectChange={onProjectChange}
          role={role}
          range={range}
          onRangeChange={onRangeChange}
          onOpenNav={() => setNavOpen(true)}
          onLogout={onLogout}
          loggingOut={loggingOut}
        />
        <main ref={main} className="page" tabIndex={-1}>
          <header className="page-header">
            <div className="page-title">
              <span className="page-icon" aria-hidden="true">
                <Icon size={20} />
              </span>
              <div>
                <h1>{title}</h1>
                <p className="page-description">{description}</p>
              </div>
            </div>
          </header>
          <div className="page-body">{children}</div>
        </main>
      </div>
      <MobileNav open={navOpen} onClose={() => setNavOpen(false)} current={page} />
    </div>
  );
}
