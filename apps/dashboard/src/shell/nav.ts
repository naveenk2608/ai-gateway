import {
  Activity,
  Boxes,
  CircleDollarSign,
  LayoutDashboard,
  ListTree,
  Server,
  Settings,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';

export type PageId =
  'overview' | 'requests' | 'cost' | 'models' | 'reliability' | 'security' | 'infra' | 'settings';

export interface PageInfo {
  id: PageId;
  title: string;
  description: string;
  icon: LucideIcon;
  /** The page shows one time range, chosen in the top bar. */
  ranged: boolean;
}

/** The dashboard's pages in sidebar order; each lives at `#<id>`. */
export const PAGES: PageInfo[] = [
  {
    id: 'overview',
    title: 'Overview',
    description: 'Traffic, outcomes, latency and spend for this project.',
    icon: LayoutDashboard,
    ranged: true,
  },
  {
    id: 'requests',
    title: 'Requests',
    description: 'Every request with its outcome, timing and routing history.',
    icon: ListTree,
    ranged: true,
  },
  {
    id: 'cost',
    title: 'Cost',
    description: 'Spend by provider, model, project and key, with budgets.',
    icon: CircleDollarSign,
    ranged: true,
  },
  {
    id: 'models',
    title: 'Models',
    description: 'Latency, speed, cost and failures per model, side by side.',
    icon: Boxes,
    ranged: true,
  },
  {
    id: 'reliability',
    title: 'Reliability',
    description: 'Errors, retries, fallbacks and circuit breakers.',
    icon: Activity,
    ranged: true,
  },
  {
    id: 'security',
    title: 'Security',
    description: 'Requests rejected by limits, budgets and policies.',
    icon: ShieldAlert,
    ranged: true,
  },
  {
    id: 'infra',
    title: 'Infrastructure',
    description: 'The usage pipeline, dependencies and this gateway instance.',
    icon: Server,
    ranged: true,
  },
  {
    id: 'settings',
    title: 'Settings',
    description: 'Project, limits, members, API keys and routing.',
    icon: Settings,
    ranged: false,
  },
];

export function pageInfo(id: PageId): PageInfo {
  return PAGES.find((p) => p.id === id) ?? PAGES[0]!;
}

export interface Route {
  page: PageId;
  /** The part after the page, e.g. a settings tab in `#settings/keys`; null when there is none. */
  section: string | null;
}

function readHash(): Route {
  const [first = '', section] = window.location.hash.slice(1).split('/');
  const page = PAGES.some((p) => p.id === first) ? (first as PageId) : 'overview';
  return { page, section: page === first && section ? section : null };
}

/** The page (and section) in the URL hash, so links, reloads and the back button keep it. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(readHash);
  useEffect(() => {
    const onHash = () => setRoute(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}
