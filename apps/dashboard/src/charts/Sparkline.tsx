import { TONES } from './theme.js';

/** The drawing box: the width stretches to the card, the height is drawn at 1:1. */
const WIDTH = 100;
const HEIGHT = 32;
/** Room for the 2 px line at the top and bottom of the box. */
const INSET = 2;

/**
 * The SVG path of a series scaled into the box, from zero to the largest value. A null point ends
 * the segment it is in, so the line has a gap there; a point alone between gaps is a dot.
 */
export function sparklinePath(values: readonly (number | null)[]): string {
  const measured = values.filter((v): v is number => v !== null);
  const max = Math.max(0, ...measured);
  const x = (i: number) => (values.length < 2 ? WIDTH / 2 : (i / (values.length - 1)) * WIDTH);
  const y = (v: number) => HEIGHT - INSET - (max > 0 ? (v / max) * (HEIGHT - 2 * INSET) : 0);

  const segments: string[][] = [];
  let current: string[] | null = null;
  values.forEach((value, i) => {
    if (value === null) {
      current = null;
      return;
    }
    if (!current) {
      current = [];
      segments.push(current);
    }
    current.push(`${x(i).toFixed(2)} ${y(value).toFixed(2)}`);
  });
  return segments
    .map(([first, ...rest]) => (rest.length ? `M${first}L${rest.join('L')}` : `M${first}h0`))
    .join('');
}

/**
 * The trend of one series in a KPI card: a line without axes over the window. Every point comes
 * from the API; the low, high and latest values are its accessible name and hover title.
 */
export function Sparkline({
  values,
  label,
  format = (n) => n.toLocaleString('en-US'),
  color = TONES.accent,
}: {
  values: readonly (number | null)[];
  /** What the series is, e.g. "Requests per hour". */
  label: string;
  format?: (value: number) => string;
  color?: string;
}) {
  const measured = values.filter((v): v is number => v !== null);
  const latest = values.findLast((v): v is number => v !== null);
  const summary =
    latest === undefined
      ? `${label}: nothing measured`
      : `${label}: low ${format(Math.min(...measured))}, high ${format(Math.max(...measured))}, latest ${format(latest)}`;
  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={summary}
    >
      <title>{summary}</title>
      <line
        x1={0}
        x2={WIDTH}
        y1={HEIGHT - INSET}
        y2={HEIGHT - INSET}
        stroke="var(--chart-grid)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={sparklinePath(values)}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
