import { describe, expect, it } from 'vitest';
import { findHardcodedData } from './check-dashboard-data.js';

const scan = (code: string) => findHardcodedData('sample.tsx', code).map((f) => f.line);

describe('hard-coded dashboard data check', () => {
  it('flags arrays of numbers and of objects holding numbers', () => {
    expect(scan('const points = [1, 2, 3];')).toEqual([1]);
    expect(scan('const temps = [-4];')).toEqual([1]);
    expect(scan("const s = [{ start: 'a', requests: 12 }];")).toEqual([1]);
    expect(scan('const s = [{ nested: { value: 3 } }];')).toEqual([1]);
    expect(scan('const grid = [[1], [2]];')).toEqual([1]);
  });

  it('flags a literal passed as chart data', () => {
    expect(scan('const c = <Chart data={[]} />;')).toEqual([1]);
    expect(scan("const c = <Chart data={{ a: 'b' }} />;")).toEqual([1]);
    expect(scan('const c = <Chart data={cond ? series : [{ x }]} />;')).toEqual([1]);
  });

  it('allows data from variables, strings, layout props and marked lines', () => {
    expect(
      scan('const c = <Chart data={response.series} margin={{ top: 8 }} height={220} />;'),
    ).toEqual([]);
    expect(scan("const ranges = ['1h', '24h'];")).toEqual([]);
    expect(scan('const c = <Chart data={rows.map((r) => ({ x: r.x, y: 0 }))} />;')).toEqual([]);
    expect(scan('// hardcoded-data-ok: page sizes, not data\nconst sizes = [10, 25];')).toEqual([]);
    expect(scan('// hardcoded-data-ok:\nconst sizes = [10, 25];')).toEqual([2]);
  });
});
