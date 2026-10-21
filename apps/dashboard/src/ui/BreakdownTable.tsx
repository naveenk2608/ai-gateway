/** Rows with a bar showing each value's share of the largest. */
export function BreakdownTable({
  label,
  rows,
}: {
  label: string;
  rows: { key: string; name: string; value: number; display: string; note?: string }[];
}) {
  const max = Math.max(...rows.map((r) => r.value));
  return (
    <div className="table-wrap">
      <table className="breakdown">
        <thead>
          <tr>
            <th>{label}</th>
            <th className="num">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>
                <div>{row.name}</div>
                <div
                  className="bar"
                  style={{ width: max > 0 ? `${(row.value / max) * 100}%` : '0%' }}
                />
              </td>
              <td className="num">
                {row.display}
                {row.note && <div className="muted small">{row.note}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
