/** Use from which a meter turns to a warning: the API's budget alert warns at the same 80%. */
export const METER_WARNING = 0.8;

/** Spend as a share of a budget; a zero budget is used up by any spend. */
export function budgetUse(spentMicroUsd: number, budgetMicroUsd: number): number {
  return budgetMicroUsd > 0 ? spentMicroUsd / budgetMicroUsd : spentMicroUsd > 0 ? 1 : 0;
}

/**
 * A share of a limit as a bar; the fill turns to a warning, then danger, as it fills. Over 100%
 * the bar stays full and the text says by how much.
 */
export function Meter({
  share,
  label,
  valueText,
}: {
  share: number;
  /** The meter's accessible name, e.g. "Budget used". */
  label: string;
  /** What a screen reader says for the value, e.g. "84%". */
  valueText?: string;
}) {
  const filled = Math.min(Math.max(share, 0), 1);
  const tone = share >= 1 ? 'danger' : share >= METER_WARNING ? 'warning' : 'accent';
  return (
    <div
      className={`meter tone-${tone}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(filled * 100)}
      aria-valuetext={valueText}
    >
      <span style={{ width: `${filled * 100}%` }} />
    </div>
  );
}
