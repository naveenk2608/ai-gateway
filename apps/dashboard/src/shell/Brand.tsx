import { Waypoints } from 'lucide-react';

/** The product mark: a generic icon on the accent colour, with the name unless `compact`. */
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden="true">
        <Waypoints size={18} strokeWidth={2.25} />
      </span>
      <span className={compact ? 'visually-hidden' : 'brand-name'}>AI Gateway</span>
    </span>
  );
}
