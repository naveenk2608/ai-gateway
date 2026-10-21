import { useRef, type KeyboardEvent } from 'react';
import { RANGES, type Range } from '../api.js';

const TITLES: Record<Range, string> = {
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

/** The time range of the ranged pages, as a radio group: arrow keys move between ranges. */
export function RangePicker({
  value,
  onChange,
}: {
  value: Range;
  onChange: (range: Range) => void;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (index: number) => {
    const next = (index + RANGES.length) % RANGES.length;
    onChange(RANGES[next]!);
    buttons.current[next]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') move(index - 1);
    else return;
    event.preventDefault();
  };
  return (
    <div className="segmented" role="radiogroup" aria-label="Time range">
      {RANGES.map((range, index) => (
        <button
          key={range}
          ref={(node) => {
            buttons.current[index] = node;
          }}
          type="button"
          role="radio"
          aria-checked={range === value}
          tabIndex={range === value ? 0 : -1}
          title={TITLES[range]}
          onClick={() => onChange(range)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {range}
        </button>
      ))}
    </div>
  );
}
