import { ChevronDown, LogOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Role } from '../api.js';

/** Up to two letters from the part of an email address before the @. */
export function initials(email: string): string {
  const name = email.split('@')[0] ?? '';
  const parts = name.split(/[._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : name.slice(0, 2);
  return letters.toUpperCase() || '?';
}

/**
 * The signed-in user: a button with their initials that opens a panel with the email, their role
 * in the current project and Log out. Escape or a click elsewhere closes it.
 */
export function UserMenu({
  email,
  role,
  onLogout,
  loggingOut,
}: {
  email: string;
  role: Role | null;
  onLogout: () => void;
  loggingOut: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="ghost user-button"
        aria-label="Account"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="avatar" aria-hidden="true">
          {initials(email)}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="popover user-popover">
          <div className="user-summary">
            <span className="avatar large" aria-hidden="true">
              {initials(email)}
            </span>
            <div className="user-details">
              <div className="user-email">{email}</div>
              <div className="muted small">
                {role ? `${role} of this project` : 'no project yet'}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="ghost menu-item"
            onClick={onLogout}
            disabled={loggingOut}
          >
            <LogOut size={16} aria-hidden="true" />
            {loggingOut ? 'Logging out…' : 'Log out'}
          </button>
        </div>
      )}
    </div>
  );
}
