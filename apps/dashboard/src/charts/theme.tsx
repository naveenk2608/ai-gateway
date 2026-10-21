/**
 * Shared chart styling (ADR 020): every chart uses these, so axes, grid, cursor and tooltip look
 * the same on every page and follow the theme through CSS custom properties.
 */
import type { ReactNode } from 'react';

export const CHART_HEIGHT = 220;

/** Axis lines and ticks off; muted labels. */
export const axisProps = {
  axisLine: false,
  tickLine: false,
  tick: { fill: 'var(--color-text-muted)', fontSize: 12 },
} as const;

/** Horizontal gridlines only, faint. */
export const gridProps = { stroke: 'var(--chart-grid)', vertical: false } as const;

export const cursorProps = { stroke: 'var(--chart-cursor)', strokeWidth: 1 } as const;

/** The hover band behind a bar chart's category. */
export const barCursorProps = { fill: 'var(--color-surface-hover)' } as const;

/** Bars are rounded at their data end only; the end at the baseline stays square. */
// hardcoded-data-ok: corner radii (top left, top right, bottom right, bottom left), not data
export const ROUNDED_TOP: [number, number, number, number] = [4, 4, 0, 0];
// hardcoded-data-ok: corner radii (top left, top right, bottom right, bottom left), not data
export const ROUNDED_RIGHT: [number, number, number, number] = [0, 4, 4, 0];

/**
 * Categorical colours in a fixed order, for series that are entities (models, projects).
 * Anything past the last one folds into "Other", which is neutral.
 */
export const CATEGORICAL = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;

/** Colours with a meaning; series without one take the chart palette. */
export const TONES = {
  accent: 'var(--color-accent)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  danger: 'var(--color-danger)',
  neutral: 'var(--color-neutral)',
} as const;

export interface Series {
  key: string;
  label: string;
  /** A CSS colour, normally one of TONES or a --chart-N variable. */
  color: string;
}

/** An id that is safe inside `url(#…)`; React's useId output contains punctuation. */
export function svgId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, '');
}

interface TooltipEntry {
  dataKey?: unknown;
  value?: unknown;
}

/** The tooltip for every chart: the point's label, then each series with its colour and value. */
export function ChartTooltip({
  active,
  payload,
  label,
  series,
  format,
  formatLabel,
}: {
  active?: boolean;
  payload?: readonly TooltipEntry[];
  label?: unknown;
  series: Series[];
  format: (value: number) => string;
  formatLabel?: (label: unknown) => ReactNode;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="chart-tooltip">
      {label !== undefined && (
        <div className="chart-tooltip-label">
          {formatLabel
            ? formatLabel(label)
            : typeof label === 'string' || typeof label === 'number'
              ? label
              : null}
        </div>
      )}
      {series.map((s) => {
        const entry = payload.find((p) => p.dataKey === s.key);
        if (!entry) return null;
        return (
          <div key={s.key} className="chart-tooltip-row">
            <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
            <span>{s.label}</span>
            <span className="value">{format(Number(entry.value))}</span>
          </div>
        );
      })}
    </div>
  );
}

/** A legend above the plot, only for charts with more than one series. */
export function ChartLegend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="chart-legend">
      {series.map((s) => (
        <li key={s.key}>
          <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ul>
  );
}
