import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatAxisTime } from '../format.js';
import type { SeriesLine } from './TimeSeriesChart.js';
import {
  axisProps,
  barCursorProps,
  CHART_HEIGHT,
  ChartTooltip,
  gridProps,
  ROUNDED_TOP,
} from './theme.js';

/** Bars wider than this look like blocks when a range has few intervals (7 days by day). */
const MAX_BAR_WIDTH = 28;

/**
 * One measure per interval of an analytics series as bars: amounts that add up, such as spend.
 * Every bar is a point the API returned.
 */
export function BarSeriesChart<T extends { start: string }>({
  data,
  bar,
  stepSeconds,
  format = (n) => n.toLocaleString('en-US'),
  label,
}: {
  data: T[];
  bar: SeriesLine<T>;
  stepSeconds: number;
  format?: (value: number) => string;
  /** Read by screen readers instead of the drawing. */
  label: string;
}) {
  const axisTime = (value: unknown) =>
    typeof value === 'string' ? formatAxisTime(value, stepSeconds) : '';
  return (
    <figure className="chart" aria-label={label}>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <BarChart
          data={data}
          margin={{ top: 8, right: 4, bottom: 0, left: 0 }}
          barCategoryGap="20%"
        >
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="start" tickFormatter={axisTime} minTickGap={32} dy={4} {...axisProps} />
          <YAxis width={56} tickFormatter={(value: number) => format(value)} {...axisProps} />
          <Tooltip
            cursor={barCursorProps}
            isAnimationActive={false}
            content={({ active, payload, label: point }) => (
              <ChartTooltip
                active={active}
                payload={payload}
                label={point}
                series={[bar]}
                format={format}
                formatLabel={axisTime}
              />
            )}
          />
          <Bar
            // Recharts types data keys loosely per chart; the key is a field of T.
            dataKey={String(bar.key)}
            name={bar.label}
            fill={bar.color}
            radius={ROUNDED_TOP}
            maxBarSize={MAX_BAR_WIDTH}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}
