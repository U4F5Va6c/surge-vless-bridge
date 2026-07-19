import type { ClashProxy } from './parse-clash';

const asString = (value: unknown): string | undefined =>
  value === undefined || value === null ? undefined : String(value);

const asBoolean = (value: unknown): boolean => value === true || value === 'true';

/** Escape a value that goes after `key=` on a Surge proxy line. Commas would
 * be read as a new parameter, so any stray comma is stripped. */
const cleanParam = (value: string): string => value.replace(/[,\n\r]/g, '').trim();

/**
 * Build a native Surge `anytls` proxy line from a Clash/mihomo anytls node.
 * Surge Mac 6.4.3+ / iOS 5.17.0+:
 *   Name = anytls, server, port, password=xxx, sni=xxx, skip-cert-verify=true
 *
 * `nodeName` is the already-sanitized, unique policy name.
 */
export const buildAnyTlsLine = (proxy: ClashProxy, nodeName: string, index: number): string => {
  const server = asString(proxy.server);
  const port = Number(proxy.port);
  const password = asString(proxy.password);

  if (!server || Number.isNaN(port) || !password) {
    throw new Error(`Invalid clash anytls node at index ${index + 1}: ${JSON.stringify(proxy)}`);
  }

  const params: string[] = [`password=${cleanParam(password)}`];

  const sni = asString(proxy.sni) ?? asString(proxy.servername);
  if (sni) {
    params.push(`sni=${cleanParam(sni)}`);
  }

  if (asBoolean(proxy['skip-cert-verify'])) {
    params.push('skip-cert-verify=true');
  }

  // Only password/sni/skip-cert-verify are documented for Surge anytls; other
  // params (e.g. udp-relay) risk Surge rejecting the whole proxy line, so they
  // are intentionally omitted.
  return `${nodeName} = anytls, ${server}, ${port}, ${params.join(', ')}`;
};
