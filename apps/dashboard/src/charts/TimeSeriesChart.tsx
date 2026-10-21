import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatAxisTime } from '../format.js';

const CHART_HEIGHT = 220;

export interface SeriesLine<T> {
  key: keyof T & string;
  label: string;
  /** A CSS colour, normally a theme variable. */
  color: string;
}

/**
 * A stacked area chart over a series from the analytics API. Every point comes from the API; the
 * chart draws nothing of its own.
 */
export function TimeSeriesChart<T extends { start: string }>({
  data,
  lines,
  stepSeconds,
  format = (n) => n.toLocaleString('en-US'),
  stacked = true,
  label,
}: {
  data: T[];
  lines: SeriesLine<T>[];
  stepSeconds: number;
  format?: (value: number) => string;
  /** Stack the areas (parts of a whole) or overlay them (measures that overlap). */
  stacked?: boolean;
  /** Read by screen readers instead of the drawing. */
  label: string;
}) {
  return (
    <figure className="chart" aria-label={label}>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="start"
            tickFormatter={(value: string) => formatAxisTime(value, stepSeconds)}
            stroke="var(--muted)"
            fontSize={12}
            minTickGap={24}
          />
          <YAxis
            stroke="var(--muted)"
            fontSize={12}
            width={56}
            tickFormatter={(value: number) => format(value)}
            allowDecimals={false}
          />
          <Tooltip
            labelFormatter={(value) =>
              typeof value === 'string' ? formatAxisTime(value, stepSeconds) : ''
            }
            formatter={(value) => format(Number(value))}
            contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          />
          <Legend />
          {lines.map((line) => (
            <Area
              key={line.key}
              type="monotone"
              // Recharts types data keys loosely per chart; the key is a field of T.
              dataKey={String(line.key)}
              name={line.label}
              stackId={stacked ? 'series' : undefined}
              stroke={line.color}
              fill={line.color}
              fillOpacity={0.25}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </figure>
  );
}
