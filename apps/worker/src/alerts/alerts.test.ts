import { newSigningSecret, verifyWebhook } from '@ai-gateway/shared/node';
import { describe, expect, it } from 'vitest';
import { crossedThresholds } from './detect.js';
import { messageText, renderDelivery, type AlertPayload } from './format.js';
import { blockedReason, vetTarget, type Resolver } from './ssrf.js';

describe('blockedReason', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'cloud metadata'],
    ['169.254.10.1', 'link-local'],
    ['100.100.100.200', 'cloud metadata'],
    ['100.64.0.1', 'shared address space'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fd00:ec2::254', 'cloud metadata'],
    ['fc00::1', 'unique local'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:a9fe:a9fe', 'cloud metadata'],
    ['64:ff9b::a9fe:a9fe', 'cloud metadata'],
    ['64:ff9b::a00:1', 'private'],
  ])('refuses %s (%s)', (address, reason) => {
    expect(blockedReason(address)).toBe(reason);
  });

  it.each(['93.184.215.14', '172.32.0.1', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows the public address %s',
    (address) => {
      expect(blockedReason(address)).toBeNull();
    },
  );
});

describe('vetTarget', () => {
  const resolving =
    (...addresses: string[]): Resolver =>
    () =>
      Promise.resolve(
        addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      );

  it('allows https to a public address and pins that address', async () => {
    const vetted = await vetTarget('https://hooks.example.com/x', resolving('93.184.215.14'));
    expect(vetted).toMatchObject({ ok: true, address: '93.184.215.14', family: 4 });
  });

  it('refuses http, credentials and invalid URLs for good', async () => {
    const ok = resolving('93.184.215.14');
    expect(await vetTarget('http://hooks.example.com/x', ok)).toEqual({
      ok: false,
      reason: 'not https',
      permanent: true,
    });
    expect(await vetTarget('https://user:pw@hooks.example.com/x', ok)).toMatchObject({
      ok: false,
      reason: 'credentials in the URL',
    });
    expect(await vetTarget('not a url', ok)).toMatchObject({ ok: false, permanent: true });
  });

  it('refuses a host that resolves to a private, loopback or metadata address', async () => {
    for (const address of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '::1', 'fd00:ec2::254']) {
      const vetted = await vetTarget('https://rebind.example.com/x', resolving(address));
      expect(vetted).toMatchObject({ ok: false, permanent: true });
      expect(vetted.ok ? '' : vetted.reason).toMatch(/^refused a /);
    }
    // One private address among public ones is enough to refuse.
    expect(
      await vetTarget('https://mixed.example.com/x', resolving('93.184.215.14', '10.0.0.5')),
    ).toMatchObject({ ok: false, reason: 'refused a private address' });
    // IP literals are checked as they are.
    expect(await vetTarget('https://127.0.0.1/x', resolving())).toMatchObject({ ok: false });
    expect(await vetTarget('https://[::1]/x', resolving())).toMatchObject({ ok: false });
  });

  it('retries a host that does not resolve', async () => {
    const failing: Resolver = () => Promise.reject(new Error('ENOTFOUND'));
    expect(await vetTarget('https://gone.example.com/x', failing)).toEqual({
      ok: false,
      reason: 'the host did not resolve',
      permanent: false,
    });
  });
});

describe('renderDelivery', () => {
  const payload: AlertPayload = {
    type: 'budget.threshold',
    timestamp: '2026-11-09T10:00:00.000Z',
    data: {
      projectName: 'Demo <team> & co',
      period: '2026-11',
      thresholdPct: 80,
      spentMicroUsd: 8_000_000,
      limitMicroUsd: 10_000_000,
    },
  };

  it('sends Discord its content with every mention disabled, at most 2,000 characters', () => {
    const { body, headers } = renderDelivery('discord', { id: 'd1', payload }, null, 0);
    expect(JSON.parse(body)).toEqual({
      content:
        'AI Gateway: project "Demo <team> & co" has used 80% of its monthly budget for 2026-11 ' +
        '($8.00 of $10.00).',
      allowed_mentions: { parse: [] },
    });
    expect(headers).toEqual({});
    const long = { ...payload, data: { ...payload.data, projectName: 'x'.repeat(3_000) } };
    const content = (
      JSON.parse(renderDelivery('discord', { id: 'd', payload: long }, null, 0).body) as {
        content: string;
      }
    ).content;
    expect(content).toHaveLength(2_000);
  });

  it("sends Slack its text, with Slack's escapes", () => {
    const { body } = renderDelivery('slack', { id: 's1', payload }, null, 0);
    expect(JSON.parse(body)).toEqual({
      text: messageText(payload).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'),
    });
  });

  it('signs generic JSON so a receiver can verify it, and a changed body or an old timestamp fails', () => {
    const secret = newSigningSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const now = Date.UTC(2026, 10, 9, 10, 0, 0);
    const { body, headers } = renderDelivery('generic', { id: 'msg_1', payload }, secret, now);
    expect(JSON.parse(body)).toEqual(payload);
    expect(headers['webhook-id']).toBe('msg_1');
    expect(headers['webhook-timestamp']).toBe(String(now / 1000));
    expect(headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    const received = {
      id: headers['webhook-id']!,
      timestamp: headers['webhook-timestamp']!,
      signature: headers['webhook-signature']!,
    };
    expect(verifyWebhook(secret, received, body, now / 1000)).toBe(true);
    expect(verifyWebhook(secret, received, body.replace('80', '81'), now / 1000)).toBe(false);
    expect(verifyWebhook(newSigningSecret(), received, body, now / 1000)).toBe(false);
    // Six minutes later: past the 5-minute tolerance.
    expect(verifyWebhook(secret, received, body, now / 1000 + 360)).toBe(false);
    expect(verifyWebhook(secret, received, body, now / 1000 + 299)).toBe(true);
  });
});

describe('crossedThresholds', () => {
  it('names each threshold a change of spend crosses, once', () => {
    expect(crossedThresholds(0, 499, 1_000)).toEqual([]);
    expect(crossedThresholds(0, 500, 1_000)).toEqual([50]);
    expect(crossedThresholds(499, 850, 1_000)).toEqual([50, 80]);
    expect(crossedThresholds(850, 1_200, 1_000)).toEqual([100]);
    expect(crossedThresholds(1_200, 1_500, 1_000)).toEqual([]);
    expect(crossedThresholds(0, 5_000, null)).toEqual([]);
    expect(crossedThresholds(0, 5_000, 0)).toEqual([]);
  });
});
