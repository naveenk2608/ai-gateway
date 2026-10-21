import { Pie, PieChart, Tooltip } from 'recharts';
import { formatPercent } from '../format.js';
import type { Share } from './series.js';
import { CATEGORICAL, TONES } from './theme.js';

/** The drawing's width and height in px; the ring is RING px thick inside it. */
const SIZE = 168;
const RING = 22;

/**
 * Parts of a total as a ring, the total in its centre and a legend with each part's share. The
 * parts take the categorical colours in order; "Other" is neutral.
 */
export function ShareDonut({
  shares,
  total,
  format,
  centerLabel,
  label,
}: {
  /** At most as many as there are categorical colours, e.g. from `foldShares`. */
  shares: Share[];
  /** What the shares are shares of; it is the centre value. */
  total: number;
  format: (value: number) => string;
  /** A word under the centre value, e.g. "total". */
  centerLabel: string;
  /** Read by screen readers instead of the drawing. */
  label: string;
}) {
  const slices = shares.map((share, i) => ({
    ...share,
    fill: share.other ? TONES.neutral : (CATEGORICAL[i] ?? TONES.neutral),
  }));
  const shareOf = (value: number) => formatPercent(total > 0 ? value / total : null);
  return (
    <figure className="donut" aria-label={label}>
      <div className="donut-plot">
        <PieChart width={SIZE} height={SIZE}>
          <Pie
            data={slices}
            dataKey="value"
            nameKey="label"
            innerRadius={SIZE / 2 - RING}
            outerRadius={SIZE / 2 - 2}
            startAngle={90}
            endAngle={-270}
            stroke="var(--color-surface)"
            strokeWidth={2}
            isAnimationActive={false}
          />
          <Tooltip
            isAnimationActive={false}
            content={({ active, payload }) => {
              const slice = payload?.[0]?.payload as (typeof slices)[number] | undefined;
              if (!active || !slice) return null;
              return (
                <div className="chart-tooltip">
                  <div className="chart-tooltip-row">
                    <span
                      className="swatch"
                      style={{ background: slice.fill }}
                      aria-hidden="true"
                    />
                    <span>{slice.label}</span>
                    <span className="value">{format(slice.value)}</span>
                  </div>
                  <div className="chart-tooltip-label">{shareOf(slice.value)} of the total</div>
                </div>
              );
            }}
          />
        </PieChart>
        <div className="donut-center">
          <span className="donut-total">{format(total)}</span>
          <span className="muted small">{centerLabel}</span>
        </div>
      </div>
      <ul className="donut-legend">
        {slices.map((slice) => (
          <li key={slice.key}>
            <span className="swatch" style={{ background: slice.fill }} aria-hidden="true" />
            <span className="donut-name" title={slice.label}>
              {slice.label}
            </span>
            <span className="donut-share">{shareOf(slice.value)}</span>
            <span className="donut-value">{format(slice.value)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
