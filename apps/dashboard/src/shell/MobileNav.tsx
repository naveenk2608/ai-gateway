import { X } from 'lucide-react';
import { Drawer } from '../ui/Drawer.js';
import { Brand } from './Brand.js';
import { GatewayPill } from './GatewayPill.js';
import type { PageId } from './nav.js';
import { NavList } from './NavList.js';

/** The navigation on narrow screens: the sidebar's contents in a drawer from the left. */
export function MobileNav({
  open,
  onClose,
  current,
}: {
  open: boolean;
  onClose: () => void;
  current: PageId;
}) {
  return (
    <Drawer open={open} onClose={onClose} side="left" label="Navigation" className="mobile-nav">
      <div className="drawer-header">
        <Brand />
        <button
          type="button"
          className="ghost icon-button"
          aria-label="Close navigation"
          onClick={onClose}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <NavList current={current} onNavigate={onClose} />
      <div className="sidebar-footer">
        <GatewayPill />
      </div>
    </Drawer>
  );
}
