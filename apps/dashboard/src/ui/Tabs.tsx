import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface Tab<Id extends string> {
  id: Id;
  label: string;
}

/**
 * Tabs that live in the URL hash (`#<page>/<tab>`), so a tab can be linked, reloaded and left with
 * the back button. Arrow keys, Home and End move between tabs; the panel holds the current one.
 */
export function Tabs<Id extends string>({
  label,
  tabs,
  current,
  href,
  children,
}: {
  label: string;
  tabs: Tab<Id>[];
  current: Id;
  href: (id: Id) => string;
  children: ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const panelId = `${label.toLowerCase().replace(/\W+/g, '-')}-panel`;

  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    const index = tabs.findIndex((t) => t.id === current);
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : null;
    const tab = next === null ? undefined : tabs[next];
    if (!tab) return;
    event.preventDefault();
    window.location.hash = href(tab.id);
    list.current?.querySelector<HTMLElement>(`[data-tab="${tab.id}"]`)?.focus();
  };

  return (
    <div className="tabs">
      <div ref={list} role="tablist" aria-label={label} className="tab-list">
        {tabs.map((tab) => {
          const selected = tab.id === current;
          return (
            <a
              key={tab.id}
              role="tab"
              data-tab={tab.id}
              href={`#${href(tab.id)}`}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              className="tab"
              onKeyDown={onKeyDown}
            >
              {tab.label}
            </a>
          );
        })}
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-label={tabs.find((t) => t.id === current)?.label}
        className="tab-panel"
      >
        {children}
      </div>
    </div>
  );
}
