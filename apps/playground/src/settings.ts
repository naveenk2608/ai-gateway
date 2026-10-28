/**
 * Where the playground connects and with which key. The key stays in this tab (sessionStorage)
 * unless the user ticks "remember on this device" (localStorage); it is only ever sent to the
 * gateway URL, in the Authorization header.
 */

export const DEFAULT_GATEWAY_URL: string =
  (import.meta.env.VITE_DEFAULT_GATEWAY_URL as string | undefined) ??
  'https://ai-gateway-8var.onrender.com';

const URL_ITEM = 'ai-gateway.playground.url';
const KEY_ITEM = 'ai-gateway.playground.key';
const MODEL_ITEM = 'ai-gateway.playground.model';

/** The gateway's API key format (ADR 006). */
const API_KEY_PATTERN = /^gw_[0-9a-f]{16}_[0-9a-f]{64}$/;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface Settings {
  gatewayUrl: string;
  apiKey: string;
  /** Keep the key in localStorage across browser sessions instead of this tab only. */
  remember: boolean;
}

/** Storage that may be missing or throw (private windows, blocked site data). */
export interface Stores {
  local: Storage | null;
  session: Storage | null;
}

export function browserStores(): Stores {
  const open = (name: 'localStorage' | 'sessionStorage') => {
    try {
      return window[name];
    } catch {
      return null;
    }
  };
  return { local: open('localStorage'), session: open('sessionStorage') };
}

function read(store: Storage | null, item: string): string | null {
  try {
    return store?.getItem(item) ?? null;
  } catch {
    return null;
  }
}

function write(store: Storage | null, item: string, value: string | null): void {
  try {
    if (value === null) store?.removeItem(item);
    else store?.setItem(item, value);
  } catch {
    // Storage is a convenience: without it the settings last until the page closes.
  }
}

export function loadSettings({ local, session }: Stores): Settings {
  const remembered = read(local, KEY_ITEM);
  return {
    gatewayUrl: read(local, URL_ITEM) ?? DEFAULT_GATEWAY_URL,
    apiKey: read(session, KEY_ITEM) ?? remembered ?? '',
    remember: remembered !== null,
  };
}

/** Saves the settings; the key goes to exactly one store, and is removed from the other. */
export function saveSettings({ local, session }: Stores, settings: Settings): void {
  write(local, URL_ITEM, settings.gatewayUrl);
  const key = settings.apiKey === '' ? null : settings.apiKey;
  write(local, KEY_ITEM, settings.remember ? key : null);
  write(session, KEY_ITEM, settings.remember ? null : key);
}

/** Removes the key from both stores. */
export function forgetKey({ local, session }: Stores): void {
  write(local, KEY_ITEM, null);
  write(session, KEY_ITEM, null);
}

export function loadModel({ local }: Stores): string | null {
  return read(local, MODEL_ITEM);
}

export function saveModel({ local }: Stores, model: string): void {
  write(local, MODEL_ITEM, model);
}

/**
 * The gateway URL in canonical form (no trailing slash), or an error message. HTTPS only, except
 * for a gateway on this machine; no credentials, query or fragment in the URL.
 */
export function checkGatewayUrl(text: string): { url: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return { error: 'Enter the full URL, e.g. https://ai-gateway.example.com.' };
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return { error: 'Use https:// (plain http:// only for a gateway on this machine).' };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { error: 'Leave out any user name, password, query or #fragment.' };
  }
  return { url: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

export function checkApiKey(text: string): { key: string } | { error: string } {
  const key = text.trim();
  if (API_KEY_PATTERN.test(key)) return { key };
  return {
    error: 'A gateway API key looks like gw_ followed by 16 and 64 hex characters.',
  };
}
