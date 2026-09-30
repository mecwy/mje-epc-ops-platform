/**
 * Express "trust proxy" setting for the client address that field throttles key on.
 *
 * On Azure Container Apps the ingress appends the real client to X-Forwarded-For, after any
 * entries the client sent itself; on a cold start (scale from zero) one more internal hop from
 * 100.64.0.0/10 is appended after it. A fixed hop count is therefore wrong on cold starts.
 * TRUST_PROXY_SUBNETS (for example "loopback,100.64.0.0/10") trusts only those addresses, so
 * the client is the rightmost X-Forwarded-For entry outside them, whatever the hop count;
 * client-supplied entries sit to its left and are never reached. Without it, TRUST_PROXY_HOPS
 * (default 0: trust nothing, use the socket address) applies.
 */
export function trustProxySetting(
  env: Record<string, string | undefined>,
): number | string[] {
  const subnets = (env['TRUST_PROXY_SUBNETS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (subnets.length > 0) return subnets;
  const hops = Number(env['TRUST_PROXY_HOPS'] ?? 0);
  if (!Number.isInteger(hops) || hops < 0)
    throw new Error('TRUST_PROXY_HOPS must be a non-negative integer');
  return hops;
}
