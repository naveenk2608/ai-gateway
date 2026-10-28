import { describe, expect, it } from 'vitest';
import {
  checkApiKey,
  checkGatewayUrl,
  DEFAULT_GATEWAY_URL,
  forgetKey,
  loadSettings,
  saveSettings,
  type Stores,
} from './settings.js';

/** An in-memory Storage. */
class MemoryStorage implements Storage {
  readonly items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

/** Storage that refuses everything, as in some private windows. */
class BlockedStorage extends MemoryStorage {
  override getItem(): string | null {
    throw new Error('blocked');
  }
  override setItem(): void {
    throw new Error('blocked');
  }
}

const KEY = `gw_${'a1'.repeat(8)}_${'b2'.repeat(32)}`;

function stores() {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  return { local, session, stores: { local, session } satisfies Stores };
}

const values = (s: MemoryStorage) => [...s.items.values()];

describe('settings storage', () => {
  it('starts with the default gateway URL and no key', () => {
    expect(loadSettings(stores().stores)).toEqual({
      gatewayUrl: DEFAULT_GATEWAY_URL,
      apiKey: '',
      remember: false,
    });
    expect(DEFAULT_GATEWAY_URL).toBe('https://ai-gateway-8var.onrender.com');
  });

  it('keeps the key in this tab only (sessionStorage) unless asked to remember it', () => {
    const { local, session, stores: s } = stores();
    saveSettings(s, { gatewayUrl: 'https://gw.example.com', apiKey: KEY, remember: false });
    expect(values(session)).toEqual([KEY]);
    expect(values(local)).not.toContain(KEY);
    expect(loadSettings(s)).toEqual({
      gatewayUrl: 'https://gw.example.com',
      apiKey: KEY,
      remember: false,
    });
  });

  it('moves the key to localStorage when remembered, and back when that is unticked', () => {
    const { local, session, stores: s } = stores();
    saveSettings(s, { gatewayUrl: 'https://gw.example.com', apiKey: KEY, remember: true });
    expect(values(local)).toContain(KEY);
    expect(values(session)).not.toContain(KEY);
    expect(loadSettings(s).remember).toBe(true);

    saveSettings(s, { gatewayUrl: 'https://gw.example.com', apiKey: KEY, remember: false });
    expect(values(local)).not.toContain(KEY);
    expect(values(session)).toEqual([KEY]);
  });

  it('forgets the key everywhere', () => {
    const { local, session, stores: s } = stores();
    saveSettings(s, { gatewayUrl: 'https://gw.example.com', apiKey: KEY, remember: true });
    forgetKey(s);
    expect([...values(local), ...values(session)]).not.toContain(KEY);
    expect(loadSettings(s).apiKey).toBe('');
  });

  it('works without storage: nothing is kept, nothing throws', () => {
    const blocked = { local: new BlockedStorage(), session: null };
    expect(() =>
      saveSettings(blocked, { gatewayUrl: 'https://gw.example.com', apiKey: KEY, remember: true }),
    ).not.toThrow();
    expect(loadSettings(blocked).apiKey).toBe('');
  });
});

describe('checkGatewayUrl', () => {
  it('accepts https URLs and drops a trailing slash', () => {
    expect(checkGatewayUrl(' https://gw.example.com/ ')).toEqual({ url: 'https://gw.example.com' });
    expect(checkGatewayUrl('https://example.com/gateway/')).toEqual({
      url: 'https://example.com/gateway',
    });
  });

  it('allows plain http only for a gateway on this machine', () => {
    expect(checkGatewayUrl('http://localhost:8080')).toEqual({ url: 'http://localhost:8080' });
    expect(checkGatewayUrl('http://127.0.0.1:8080')).toEqual({ url: 'http://127.0.0.1:8080' });
    expect(checkGatewayUrl('http://gw.example.com')).toHaveProperty('error');
  });

  it('refuses URLs with credentials, a query or a fragment, and non-URLs', () => {
    for (const text of [
      'https://user:pw@gw.example.com',
      'https://gw.example.com/?key=x',
      'https://gw.example.com/#x',
      'gw.example.com',
      'javascript:alert(1)',
    ]) {
      expect(checkGatewayUrl(text)).toHaveProperty('error');
    }
  });
});

describe('checkApiKey', () => {
  it('accepts a gateway key and refuses anything else', () => {
    expect(checkApiKey(` ${KEY} `)).toEqual({ key: KEY });
    expect(checkApiKey('sk-not-a-gateway-key')).toHaveProperty('error');
    expect(checkApiKey(KEY.toUpperCase())).toHaveProperty('error');
  });
});
