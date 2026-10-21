import { Menu } from 'lucide-react';
import type { Me, Range, Role } from '../api.js';
import { Brand } from './Brand.js';
import { ProjectSelect } from './ProjectSelect.js';
import { RangePicker } from './RangePicker.js';
import { ThemeToggle } from './ThemeToggle.js';
import { UserMenu } from './UserMenu.js';

/**
 * The bar above every page: the project and time range on the left and right of the context
 * area, then the theme toggle and the account menu. On narrow screens a menu button opens the
 * navigation and the context area moves to its own row.
 */
export function Topbar({
  me,
  projectId,
  onProjectChange,
  role,
  range,
  onRangeChange,
  onOpenNav,
  onLogout,
  loggingOut,
}: {
  me: Me;
  projectId: string | null;
  onProjectChange: (projectId: string) => void;
  role: Role | null;
  /** Null hides the picker: the page shows no time range. */
  range: Range | null;
  onRangeChange: (range: Range) => void;
  onOpenNav: () => void;
  onLogout: () => void;
  loggingOut: boolean;
}) {
  return (
    <header className="topbar">
      <button
        type="button"
        className="ghost icon-button nav-toggle"
        aria-label="Open navigation"
        onClick={onOpenNav}
      >
        <Menu size={20} aria-hidden="true" />
      </button>
      <span className="topbar-brand">
        <Brand />
      </span>
      <div className="topbar-context">
        {projectId && me.projects.length > 0 ? (
          <ProjectSelect projects={me.projects} value={projectId} onChange={onProjectChange} />
        ) : (
          <span />
        )}
        {range && <RangePicker value={range} onChange={onRangeChange} />}
      </div>
      <ThemeToggle />
      <UserMenu email={me.user.email} role={role} onLogout={onLogout} loggingOut={loggingOut} />
    </header>
  );
}
