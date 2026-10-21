import { useId } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatAxisTime } from '../format.js';
import {
  axisProps,
  CHART_HEIGHT,
  ChartLegend,
  ChartTooltip,
  cursorProps,
  gridProps,
  svgId,
} from './theme.js';

export interface SeriesLine<T> {
  key: keyof T & string;
  label: string;
  /** A CSS colour, normally a theme variable. */
  color: string;
}

/**
 * An area chart over a series from the analytics API. Every point comes from the API; the chart
 * draws nothing of its own.
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
  const gradient = svgId(useId());
  const axisTime = (value: unknown) =>
    typeof value === 'string' ? formatAxisTime(value, stepSeconds) : '';
  return (
    <figure className="chart" aria-label={label}>
      <ChartLegend series={lines} />
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <AreaChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
          <defs>
            {lines.map((line) => (
              <linearGradient
                key={line.key}
                id={`${gradient}-${line.key}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={line.color} stopOpacity={0.3} />
                <stop offset="100%" stopColor={line.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="start" tickFormatter={axisTime} minTickGap={32} dy={4} {...axisProps} />
          <YAxis
            width={56}
            tickFormatter={(value: number) => format(value)}
            allowDecimals={false}
            {...axisProps}
          />
          <Tooltip
            cursor={cursorProps}
            isAnimationActive={false}
            content={({ active, payload, label: point }) => (
              <ChartTooltip
                active={active}
                payload={payload}
                label={point}
                series={lines}
                format={format}
                formatLabel={axisTime}
              />
            )}
          />
          {lines.map((line) => (
            <Area
              key={line.key}
              type="monotone"
              // Recharts types data keys loosely per chart; the key is a field of T.
              dataKey={String(line.key)}
              name={line.label}
              stackId={stacked ? 'series' : undefined}
              stroke={line.color}
              strokeWidth={1.5}
              fill={`url(#${gradient}-${line.key})`}
              fillOpacity={1}
              activeDot={{ r: 3, strokeWidth: 0, fill: line.color }}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </figure>
  );
}
