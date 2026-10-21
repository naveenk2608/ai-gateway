import { PAGES, type PageId } from './nav.js';

/**
 * Links to every page; the current one is marked for assistive technology and styled. `iconOnly`
 * (the collapsed sidebar) keeps each name for screen readers and as a tooltip.
 */
export function NavList({
  current,
  onNavigate,
  iconOnly = false,
}: {
  current: PageId;
  onNavigate?: () => void;
  iconOnly?: boolean;
}) {
  return (
    <nav aria-label="Pages">
      <ul className="nav-list">
        {PAGES.map(({ id, title, icon: Icon }) => (
          <li key={id}>
            <a
              href={`#${id}`}
              className="nav-link"
              aria-current={id === current ? 'page' : undefined}
              title={iconOnly ? title : undefined}
              onClick={onNavigate}
            >
              <Icon size={18} aria-hidden="true" />
              <span className={iconOnly ? 'visually-hidden' : 'nav-label'}>{title}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
