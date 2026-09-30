import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { trustProxySetting } from './trust-proxy.js';

/** The address Express derives for a request arriving from loopback with this header. */
async function clientIp(setting: number | string[], xff?: string) {
  const app = express();
  app.set('trust proxy', setting);
  app.get('/', (req, res) => res.send(req.ip));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    const r = await fetch(`http://127.0.0.1:${port}/`, {
      headers: xff ? { 'x-forwarded-for': xff } : {},
    });
    return await r.text();
  } finally {
    server.close();
  }
}

// TEST addresses only (documentation ranges); 100.100.0.105 is the observed internal hop.
const CLIENT = '198.51.100.20';
const INTERNAL = '100.100.0.105';
const FORGED = '203.0.113.7';
const CLIENT6 = '2001:db8::20';

describe('trust proxy setting', () => {
  it('reads subnets first, then hop count; rejects a bad hop count', () => {
    expect(
      trustProxySetting({ TRUST_PROXY_SUBNETS: 'loopback, 100.64.0.0/10' }),
    ).toEqual(['loopback', '100.64.0.0/10']);
    expect(trustProxySetting({ TRUST_PROXY_HOPS: '1' })).toBe(1);
    expect(trustProxySetting({})).toBe(0);
    expect(
      trustProxySetting({
        TRUST_PROXY_SUBNETS: 'loopback',
        TRUST_PROXY_HOPS: '3',
      }),
    ).toEqual(['loopback']);
    expect(() => trustProxySetting({ TRUST_PROXY_HOPS: '-1' })).toThrow();
  });

  it('subnets give the real client on warm and cold-start ingress paths and ignore forged entries', async () => {
    const setting = trustProxySetting({
      TRUST_PROXY_SUBNETS: 'loopback,100.64.0.0/10',
    });
    // warm: ingress appends the client
    expect(await clientIp(setting, CLIENT)).toBe(CLIENT);
    // cold start: an internal hop is appended after the client
    expect(await clientIp(setting, `${CLIENT}, ${INTERNAL}`)).toBe(CLIENT);
    // forged entries sent by the client sit to the left of the real one
    expect(await clientIp(setting, `${FORGED},${CLIENT}`)).toBe(CLIENT);
    expect(await clientIp(setting, `${FORGED}, ${INTERNAL},${CLIENT}`)).toBe(
      CLIENT,
    );
    // forged entries on the cold-start path
    expect(await clientIp(setting, `${FORGED}, ${CLIENT}, ${INTERNAL}`)).toBe(
      CLIENT,
    );
    // IPv6 client behind the observed IPv4 hops; IPv4-mapped internal hop
    expect(await clientIp(setting, `${CLIENT6}, ${INTERNAL}`)).toBe(CLIENT6);
    expect(await clientIp(setting, `${CLIENT}, ::ffff:${INTERNAL}`)).toBe(
      CLIENT,
    );
  });

  it('a fixed single hop returns the internal address on a cold start (why subnets are used)', async () => {
    expect(await clientIp(1, `${CLIENT}, ${INTERNAL}`)).toBe(INTERNAL);
  });

  it('documented limit: a client whose ingress-observed address is inside the trusted range lets a forged entry through', async () => {
    const setting = ['loopback', '100.64.0.0/10'];
    expect(await clientIp(setting, `${FORGED}, 100.64.1.2`)).toBe(FORGED);
  });
});
