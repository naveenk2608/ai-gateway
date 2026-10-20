const MAX_TIMESTAMP = 2 ** 48 - 1;

/**
 * UUIDv7 (RFC 9562): a 48-bit Unix millisecond timestamp followed by random bits, so IDs sort by
 * creation time to the millisecond. Used for request IDs and primary keys.
 */
export function uuidv7(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIMESTAMP) {
    throw new RangeError(`uuidv7 timestamp out of range: ${now}`);
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // Bitwise operators truncate to 32 bits, so split the 48-bit timestamp arithmetically.
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 9562 variant

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
