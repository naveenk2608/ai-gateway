import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * One headline number: an icon tile, the label, the value, an optional note and its trend. The
 * analytics API returns a single window, so there is no comparison with a previous period.
 */
export function KpiCard({
  icon: Icon,
  label,
  value,
  note,
  trend,
}: {
  icon: LucideIcon;
  label: string;
  /** The formatted value, or a placeholder (a skeleton) while it loads. */
  value: ReactNode;
  note?: string;
  /** A sparkline from an API series, or a `NoTrend` saying why there is none. */
  trend: ReactNode;
}) {
  return (
    <section className="kpi" aria-label={label}>
      <div className="kpi-head">
        <span className="kpi-icon" aria-hidden="true">
          <Icon size={18} />
        </span>
        <div className="kpi-text">
          <div className="kpi-label">{label}</div>
          <div className="kpi-value">{value}</div>
        </div>
      </div>
      {note && <div className="kpi-note">{note}</div>}
      <div className="kpi-trend">{trend}</div>
    </section>
  );
}

/** The trend slot of a card whose series the API does not return (or that has nothing in it). */
export function NoTrend({ children = 'no trend data' }: { children?: ReactNode }) {
  return <span className="kpi-no-trend">{children}</span>;
}
