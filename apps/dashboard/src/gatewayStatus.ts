export interface CheckStatus {
  name: string;
  ok: boolean;
  latencyMs: number | null;
}

export type GatewayStatus =
  | { kind: 'ready'; checks: CheckStatus[] }
  | { kind: 'not_ready'; checks: CheckStatus[] }
  | { kind: 'unreachable'; httpStatus: number | null };

function parseChecks(body: unknown): CheckStatus[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const checks = (body as { checks?: unknown }).checks;
  if (typeof checks !== 'object' || checks === null) return null;

  return Object.entries(checks as Record<string, unknown>).map(([name, value]) => {
    const check = (typeof value === 'object' && value !== null ? value : {}) as {
      status?: unknown;
      latencyMs?: unknown;
    };
    return {
      name,
      ok: check.status === 'ok',
      latencyMs: typeof check.latencyMs === 'number' ? check.latencyMs : null,
    };
  });
}

/**
 * Reads the gateway's GET /ready. Never throws: network errors and
 * unexpected responses become `unreachable`.
 */
export async function fetchGatewayStatus(
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<GatewayStatus> {
  let res: Response;
  try {
    res = await fetchFn('/ready', { headers: { accept: 'application/json' }, signal });
  } catch {
    return { kind: 'unreachable', httpStatus: null };
  }

  if (res.status === 200 || res.status === 503) {
    const checks = parseChecks(await res.json().catch(() => null));
    if (checks) return { kind: res.status === 200 ? 'ready' : 'not_ready', checks };
  }
  return { kind: 'unreachable', httpStatus: res.status };
}
