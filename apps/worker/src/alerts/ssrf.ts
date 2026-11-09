import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Resolves a host name to every address it has. */
export type Resolver = (host: string) => Promise<{ address: string; family: 4 | 6 }[]>;

export const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));

/** Where to send: the parsed URL and the one checked address the connection is pinned to. */
export interface Target {
  url: URL;
  address: string;
  family: 4 | 6;
}

export type Vetted =
  | ({ ok: true } & Target)
  /** `permanent`: the URL or its address is refused; otherwise the lookup failed (retry). */
  | { ok: false; reason: string; permanent: boolean };

/** Address ranges an alert is never sent to, with the reason named in the delivery's error. */
const V4: [string, number, string][] = [
  ['169.254.169.254', 32, 'cloud metadata'],
  ['100.100.100.200', 32, 'cloud metadata'],
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'shared address space'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];
const V6: [string, number, string][] = [
  ['fd00:ec2::254', 128, 'cloud metadata'],
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['64:ff9b:1::', 48, 'reserved'],
  ['100::', 64, 'reserved'],
  ['2001:db8::', 32, 'documentation'],
  ['fc00::', 7, 'unique local'],
  ['fe80::', 10, 'link-local'],
  ['ff00::', 8, 'multicast'],
];

function v4Number(address: string): number {
  return address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

/** The 128-bit value of an IPv6 address (with `::` and an embedded IPv4 tail). */
function v6Number(address: string): bigint {
  let text = address.toLowerCase().split('%')[0]!;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const n = v4Number(tail[1]!);
    text = `${text.slice(0, tail.index)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = text.includes('::') ? text.split('::') : [text, undefined];
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const groups =
    rest === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return groups.reduce((n, g) => (n << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
}

function inV4(address: string, base: string, bits: number): boolean {
  const shift = 32 - bits;
  return v4Number(address) >>> shift === v4Number(base) >>> shift;
}

function inV6(value: bigint, base: string, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return value >> shift === v6Number(base) >> shift;
}

/** Why an address is refused (private, loopback, link-local, metadata, ...), or null if public. */
export function blockedReason(address: string): string | null {
  const family = isIP(address);
  if (family === 4) {
    return V4.find(([base, bits]) => inV4(address, base, bits))?.[2] ?? null;
  }
  if (family !== 6) return 'not an IP address';
  const value = v6Number(address);
  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) addresses carry an IPv4 address.
  const embedded = value & 0xffffffffn;
  const v4 = [24, 16, 8, 0].map((s) => Number((embedded >> BigInt(s)) & 0xffn)).join('.');
  if (inV6(value, '::ffff:0:0', 96) || inV6(value, '64:ff9b::', 96)) return blockedReason(v4);
  return V6.find(([base, bits]) => inV6(value, base, bits))?.[2] ?? null;
}

/**
 * Checks an alert URL before each send (ADR 033): https only, no credentials in it, and a host
 * whose every address is public (no private, loopback, link-local, unique-local, shared, reserved
 * or cloud-metadata address). The send then connects to the address checked here, so a DNS answer
 * that changes between the check and the connection cannot reach another address.
 */
export async function vetTarget(raw: string, resolve: Resolver): Promise<Vetted> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL', permanent: true };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not https', permanent: true };
  if (url.username || url.password) {
    return { ok: false, reason: 'credentials in the URL', permanent: true };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: { address: string; family: 4 | 6 }[];
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
  } else {
    try {
      addresses = await resolve(host);
    } catch {
      return { ok: false, reason: 'the host did not resolve', permanent: false };
    }
    if (addresses.length === 0) {
      return { ok: false, reason: 'the host did not resolve', permanent: false };
    }
  }
  for (const a of addresses) {
    const reason = blockedReason(a.address);
    if (reason) return { ok: false, reason: `refused a ${reason} address`, permanent: true };
  }
  return { ok: true, url, address: addresses[0]!.address, family: addresses[0]!.family };
}
