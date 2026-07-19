import { writeTextFile } from './utils/fs';
import { decodeSubscription } from './utils/decode-subscription';
import { looksLikeClashYaml, parseClashProxies, type ClashProxy } from './utils/parse-clash';
import { clashVlessToOutbound } from './utils/clash-vless-to-outbound';
import { parseVlessNode } from './utils/parse-vless-node';
import type { SingBoxVlessOutbound } from './types/sing-box-vless-outbound';

export type CollectedProxies = {
  /** vless nodes, converted to sing-box outbounds (routed via sing-box external). */
  vlessOutbounds: SingBoxVlessOutbound[];
  /** anytls nodes, kept as raw Clash objects (written as native Surge proxies). */
  anytlsProxies: ClashProxy[];
  /** nodes whose protocol this bridge does not handle yet. */
  skipped: Array<{ name: string; type: string }>;
};

/** Normalize the configured subscription URL(s) into a plain string list.
 * Accepts a single string, a comma/newline separated string, or an array. */
export const normalizeSubscriptionUrls = (input: string | string[] | undefined): string[] => {
  if (!input) {
    return [];
  }
  const list = Array.isArray(input) ? input : input.split(/[\n,]/);
  return list.map((url) => url.trim()).filter((url) => url !== '');
};

const fetchSubscriptionText = async (
  subscriptionUrl: string,
  requestHeaders?: Record<string, string>,
): Promise<string> => {
  const response = await fetch(subscriptionUrl, { headers: requestHeaders });
  if (!response.ok) {
    throw new Error(`Failed to fetch subscription ${subscriptionUrl}: ${response.status} ${response.statusText}`);
  }
  return response.text();
};

/** Parse one subscription payload (Clash YAML or legacy base64/vless list)
 * into the collected buckets, appending into the provided accumulator. */
const ingestSubscription = (rawData: string, acc: CollectedProxies): void => {
  if (looksLikeClashYaml(rawData)) {
    const proxies = parseClashProxies(rawData);
    proxies.forEach((proxy, index) => {
      const type = String(proxy.type ?? '');
      if (type === 'vless') {
        acc.vlessOutbounds.push(clashVlessToOutbound(proxy, index));
      } else if (type === 'anytls') {
        acc.anytlsProxies.push(proxy);
      } else {
        acc.skipped.push({ name: String(proxy.name ?? `node${index + 1}`), type: type || 'unknown' });
      }
    });
    return;
  }

  // Legacy path: base64-encoded (or plain) list of `scheme://` URIs. Only
  // vless is understood here, matching the original tool's behaviour.
  const decoded = decodeSubscription(rawData);
  const lines = decoded.split('\n').filter((line) => line.trim() !== '');
  const vlessLines = lines.filter((line) => line.startsWith('vless://'));
  vlessLines.forEach((line, index) => {
    acc.vlessOutbounds.push(parseVlessNode(line, index));
  });

  const skippedSchemes = lines.filter(
    (line) => /^[a-z0-9]+:\/\//i.test(line) && !line.startsWith('vless://'),
  );
  skippedSchemes.forEach((line) => {
    const scheme = line.slice(0, line.indexOf('://'));
    acc.skipped.push({ name: line.slice(0, 24), type: scheme });
  });
};

/**
 * Fetch every configured subscription and merge their nodes, splitting vless
 * (→ sing-box external) from anytls (→ native Surge). Unsupported protocols
 * are collected in `skipped` so the caller can report them.
 */
export const collectSubscriptionProxies = async ({
  subscriptionUrls,
  requestHeaders,
  subscriptionOutputPath,
}: {
  subscriptionUrls: string[];
  requestHeaders?: Record<string, string>;
  subscriptionOutputPath?: string;
}): Promise<CollectedProxies> => {
  const acc: CollectedProxies = { vlessOutbounds: [], anytlsProxies: [], skipped: [] };

  for (const url of subscriptionUrls) {
    const rawData = await fetchSubscriptionText(url, requestHeaders);
    ingestSubscription(rawData, acc);
  }

  if (subscriptionOutputPath) {
    const summary = [
      ...acc.vlessOutbounds.map((o) => `vless\t${o.tag}\t${o.server}:${o.server_port}`),
      ...acc.anytlsProxies.map((p) => `anytls\t${p.name}\t${p.server}:${p.port}`),
    ].join('\n');
    await writeTextFile(subscriptionOutputPath, `${summary}\n`);
  }

  return acc;
};
