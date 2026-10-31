import { useCallback, useEffect, useState } from 'react';
import { api, type ApiKey } from '../api.js';

/** The name the Playground's keys carry in Settings → API keys. */
export const KEY_NAME = 'playground';
/** How long a Playground key works: the gateway refuses it after this, whatever happens here. */
export const KEY_LIFETIME_SECONDS = 3600;
/** A new key is made this long before the current one expires, so a chat never meets it expired. */
export const RENEW_BEFORE_MS = 5 * 60_000;

export type PlaygroundKey =
  | { status: 'creating' }
  | { status: 'ready'; key: string; apiKeyId: string; expiresAt: number }
  | { status: 'failed'; error: unknown };

function revoke(projectId: string, apiKeyId: string) {
  // keepalive: the call still goes out when the tab is closing. A key already revoked (409) or
  // a failed call needs nothing more: the key expires on its own.
  void api(`/admin/projects/${projectId}/api-keys/${apiKeyId}/revoke`, {
    method: 'POST',
    keepalive: true,
  }).catch(() => undefined);
}

/**
 * A short-lived API key for the project, made through the admin API while the Playground is open
 * and held only in memory. It is revoked when the page goes away (another page, another project,
 * a closed tab), replaced shortly before it expires, and `renew` replaces it on demand.
 */
export function usePlaygroundKey(projectId: string): PlaygroundKey & { renew: () => void } {
  const [generation, setGeneration] = useState(0);
  const [result, setResult] = useState<{ generation: number; key: PlaygroundKey } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let current: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      if (current) revoke(projectId, current);
      current = null;
    };
    // A page restored from the back/forward cache had its key revoked when it was hidden.
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) setGeneration((g) => g + 1);
    };
    window.addEventListener('pagehide', release);
    window.addEventListener('pageshow', onShow);

    api<{ apiKey: ApiKey; key: string }>(`/admin/projects/${projectId}/api-keys`, {
      method: 'POST',
      body: { name: KEY_NAME, expiresInSeconds: KEY_LIFETIME_SECONDS },
      signal: controller.signal,
    }).then(
      ({ apiKey, key }) => {
        if (controller.signal.aborted) return revoke(projectId, apiKey.id);
        current = apiKey.id;
        const parsed = Date.parse(apiKey.expiresAt ?? '');
        const expiresAt = Number.isNaN(parsed) ? Date.now() + KEY_LIFETIME_SECONDS * 1000 : parsed;
        setResult({ generation, key: { status: 'ready', key, apiKeyId: apiKey.id, expiresAt } });
        timer = setTimeout(
          () => setGeneration((g) => g + 1),
          Math.max(0, expiresAt - Date.now() - RENEW_BEFORE_MS),
        );
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setResult({ generation, key: { status: 'failed', error } });
        }
      },
    );

    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener('pagehide', release);
      window.removeEventListener('pageshow', onShow);
      release();
    };
  }, [projectId, generation]);

  const renew = useCallback(() => setGeneration((g) => g + 1), []);
  const key: PlaygroundKey =
    result && result.generation === generation ? result.key : { status: 'creating' };
  return { ...key, renew };
}
