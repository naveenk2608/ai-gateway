import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  axisProps,
  barCursorProps,
  ChartLegend,
  ChartTooltip,
  ROUNDED_RIGHT,
  type Series,
} from './theme.js';

/** Each bar's thickness, the gap between a category's bars, and room for the value axis. */
const BAR = 10;
const BAR_GAP = 2;
const CATEGORY_PADDING = 18;
const AXIS_ROOM = 32;
/** Category names longer than this are cut on the axis; the tooltip has them in full. */
const NAME_CHARS = 18;
const NAME_WIDTH = 132;

/** Gridlines run with the bars' length: vertical lines only. */
const verticalGrid = { stroke: 'var(--chart-grid)', horizontal: false } as const;

const shorten = (name: string) =>
  name.length > NAME_CHARS ? `${name.slice(0, NAME_CHARS - 1)}…` : name;

/**
 * Measures side by side per category, as horizontal bars: names stay readable at any width and
 * the chart grows with the number of categories. Every bar is a value the API returned.
 */
export function CategoryBarChart<T extends { name: string }>({
  data,
  bars,
  format,
  label,
}: {
  data: T[];
  bars: (Series & { key: keyof T & string })[];
  format: (value: number) => string;
  /** Read by screen readers instead of the drawing. */
  label: string;
}) {
  const height = data.length * (bars.length * (BAR + BAR_GAP) + CATEGORY_PADDING) + AXIS_ROOM;
  return (
    <figure className="chart" aria-label={label}>
      <ChartLegend series={bars} />
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          layout="vertical"
          data={data}
          margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          barGap={BAR_GAP}
          barCategoryGap={CATEGORY_PADDING / 2}
        >
          <CartesianGrid {...verticalGrid} />
          <XAxis type="number" tickFormatter={(value: number) => format(value)} {...axisProps} />
          <YAxis
            type="category"
            dataKey="name"
            width={NAME_WIDTH}
            tickFormatter={(value: unknown) => (typeof value === 'string' ? shorten(value) : '')}
            {...axisProps}
          />
          <Tooltip
            cursor={barCursorProps}
            isAnimationActive={false}
            content={({ active, payload, label: name }) => (
              <ChartTooltip
                active={active}
                payload={payload}
                label={name}
                series={bars}
                format={format}
              />
            )}
          />
          {bars.map((bar) => (
            <Bar
              key={bar.key}
              // Recharts types data keys loosely per chart; the key is a field of T.
              dataKey={String(bar.key)}
              name={bar.label}
              fill={bar.color}
              barSize={BAR}
              radius={ROUNDED_RIGHT}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}
