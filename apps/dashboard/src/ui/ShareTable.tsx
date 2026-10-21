import type { ReactNode } from 'react';
import { formatPercent } from '../format.js';

export interface ShareRow {
  key: string;
  name: ReactNode;
  /** The row's other columns, in the order of `columns`. */
  cells: ReactNode[];
  value: number;
}

/**
 * A breakdown with each row's share of a total: the name, its other columns, the value, and the
 * share as a percentage over a bar. The total comes from the API's totals, so rows the breakdown
 * cut off still count in it.
 */
export function ShareTable({
  label,
  columns,
  valueLabel,
  rows,
  total,
  format,
}: {
  /** The first column's header, e.g. "Project". */
  label: string;
  columns: string[];
  valueLabel: string;
  rows: ShareRow[];
  total: number;
  format: (value: number) => string;
}) {
  return (
    <div className="table-wrap">
      <table className="share-table">
        <thead>
          <tr>
            <th>{label}</th>
            {columns.map((column) => (
              <th key={column} className="num">
                {column}
              </th>
            ))}
            <th className="num">{valueLabel}</th>
            <th className="share-col">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const share = total > 0 ? row.value / total : null;
            return (
              <tr key={row.key}>
                <td className="share-name">{row.name}</td>
                {row.cells.map((cell, i) => (
                  <td key={columns[i] ?? i} className="num">
                    {cell}
                  </td>
                ))}
                <td className="num">{format(row.value)}</td>
                <td className="share-col">
                  <div className="share-cell">
                    <span className="share-track" aria-hidden="true">
                      <span style={{ width: `${Math.min(share ?? 0, 1) * 100}%` }} />
                    </span>
                    <span className="mono">{formatPercent(share)}</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
