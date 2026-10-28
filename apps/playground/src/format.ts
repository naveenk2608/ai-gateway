/** Milliseconds as "820 ms" or "1.42 s". */
export function formatMs(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(2)} s`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** The end of an ID, enough to tell requests apart; the full ID is in the title and copy. */
export function shortId(id: string): string {
  return id.length > 8 ? `…${id.slice(-8)}` : id;
}
