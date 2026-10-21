import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Brand } from './Brand.js';
import { GatewayPill } from './GatewayPill.js';
import type { PageId } from './nav.js';
import { NavList } from './NavList.js';

/** The desktop sidebar: brand, page links, gateway status and the collapse toggle. */
export function Sidebar({
  current,
  collapsed,
  onToggle,
}: {
  current: PageId;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-inner">
        <Brand compact={collapsed} />
        <NavList current={current} iconOnly={collapsed} />
        <div className="sidebar-footer">
          <GatewayPill />
          <button
            type="button"
            className="ghost icon-button sidebar-toggle"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={onToggle}
          >
            {collapsed ? (
              <PanelLeftOpen size={18} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={18} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </aside>
  );
}
