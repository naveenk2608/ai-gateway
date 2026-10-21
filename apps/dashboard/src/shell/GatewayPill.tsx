import { useQuery } from '@tanstack/react-query';
import { fetchGatewayStatus, type GatewayStatus } from '../gatewayStatus.js';

const LABELS: Record<GatewayStatus['kind'], { text: string; dot: string }> = {
  ready: { text: 'Gateway ready', dot: 'ok' },
  not_ready: { text: 'Gateway not ready', dot: 'warn' },
  unreachable: { text: 'Gateway unreachable', dot: 'fail' },
};

/** The gateway's readiness (GET /ready), refreshed every 30 s; shares its query with Overview. */
export function GatewayPill() {
  const status = useQuery({
    queryKey: ['ready'],
    queryFn: ({ signal }) => fetchGatewayStatus(fetch, signal),
    refetchInterval: 30_000,
  });
  const label = status.data ? LABELS[status.data.kind] : null;
  return (
    <div className="gateway-pill" role="status" title={label?.text ?? 'Checking the gateway'}>
      <span className={`dot ${label?.dot ?? ''}`} aria-hidden="true" />
      <span className="gateway-pill-text">{label?.text ?? 'Checking the gateway…'}</span>
    </div>
  );
}
