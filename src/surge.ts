import { Resolver, lookup } from 'node:dns/promises';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, join, resolve } from 'node:path';

import { collectSubscriptionProxies, normalizeSubscriptionUrls } from './parse';
import type { AddressResolverConfig, CliConfig } from './types/cli-config';
import type { SingBoxVlessOutbound } from './types/sing-box-vless-outbound';
import { parseTemplate } from './utils/parse-template';
import { pathExists, readJsonFile, readTextFile, writeBinaryFile, writeTextFile } from './utils/fs';
import { buildAnyTlsLine } from './utils/build-anytls-line';
import { uniquePolicyName } from './utils/policy-name';
import { buildAirportTrafficScript } from './utils/panel-script';

/** Filename of the generated Surge traffic-panel script inside `outputDir`. */
const TRAFFIC_PANEL_FILE = 'airport-traffic.js';

const DOH_RECORD_TYPES = {
  A: 1,
  AAAA: 28,
} as const;

/** Sidecar file storing the anytls native proxy lines, so `rebuild` can
 * regenerate them without re-fetching (they have no sing-box config of their
 * own, unlike vless nodes). */
const ANYTLS_SIDECAR_FILE = 'anytls-nodes.json';

type GeneratedNode = {
  nodeName: string;
  port: number;
  configPath: string;
  server: string;
};

type AnyTlsEntry = {
  name: string;
  line: string;
};

type SingBoxConfig = {
  outbounds?: Array<{
    tag?: string;
    server?: string;
  }>;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isSurgeFakeIp = (address: string) => {
  if (isIP(address) !== 4) {
    return false;
  }

  const [first, second] = address.split('.').map((part) => Number(part));
  return first === 198 && (second === 18 || second === 19);
};

const uniqueRealAddresses = (addresses: string[], resolverConfig: AddressResolverConfig) => [
  ...new Set(
    addresses.filter((address) => isIP(address) && (!resolverConfig.filterSurgeFakeIp || !isSurgeFakeIp(address))),
  ),
];

const resolveWithSystem = async (server: string) => {
  const records = await lookup(server, { all: true });
  return records.map((record) => record.address);
};

const resolveWithDnsServers = async (server: string, dnsServers: string[]) => {
  const resolver = new Resolver();
  if (dnsServers.length > 0) {
    resolver.setServers(dnsServers);
  }

  const settled = await Promise.allSettled([resolver.resolve4(server), resolver.resolve6(server)]);
  return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
};

const queryDohAddresses = async (server: string, recordType: keyof typeof DOH_RECORD_TYPES, dohEndpoint: string) => {
  const url = new URL(dohEndpoint);
  url.searchParams.set('name', server);
  url.searchParams.set('type', recordType);

  const response = await fetch(url, {
    headers: {
      accept: 'application/dns-json',
    },
  });

  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as {
    Answer?: Array<{
      type?: number;
      data?: string;
    }>;
  };

  if (!Array.isArray(payload.Answer)) {
    return [];
  }

  const answerType = DOH_RECORD_TYPES[recordType];
  return payload.Answer.filter((answer) => answer.type === answerType && typeof answer.data === 'string').map(
    (answer) => answer.data as string,
  );
};

const resolveWithDoh = async (server: string, dohEndpoint: string) => {
  const settled = await Promise.allSettled([
    queryDohAddresses(server, 'A', dohEndpoint),
    queryDohAddresses(server, 'AAAA', dohEndpoint),
  ]);
  return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
};

const resolveAddresses = async (server: string, resolverConfig: AddressResolverConfig) => {
  if (resolverConfig.strategy === 'off') {
    return [];
  }

  if (isIP(server)) {
    return uniqueRealAddresses([server], resolverConfig);
  }

  try {
    if (resolverConfig.strategy === 'doh') {
      const dohAddresses = uniqueRealAddresses(
        await resolveWithDoh(server, resolverConfig.dohEndpoint),
        resolverConfig,
      );
      if (dohAddresses.length > 0) {
        return dohAddresses;
      }

      return uniqueRealAddresses(await resolveWithDnsServers(server, resolverConfig.dnsServers), resolverConfig);
    }

    if (resolverConfig.strategy === 'dns') {
      return uniqueRealAddresses(await resolveWithDnsServers(server, resolverConfig.dnsServers), resolverConfig);
    }

    return uniqueRealAddresses(await resolveWithSystem(server), resolverConfig);
  } catch (error) {
    console.error(`Failed to resolve ${server}:`, error);
    return [];
  }
};

const buildExternalProxyLine = async ({
  nodeName,
  port,
  configPath,
  server,
  singBoxBinary,
  addressResolver,
}: GeneratedNode & { singBoxBinary: string; addressResolver: AddressResolverConfig }) => {
  const addresses = await resolveAddresses(server, addressResolver);
  const addressArg = addresses.length > 0 ? `, addresses=${addresses[0]}` : '';
  return `${nodeName} = external, exec=${singBoxBinary}, args=run, args=-c, args=${configPath}, local-port=${port}${addressArg}`;
};

const ensureRequiredConfig = (config: CliConfig) => {
  if (normalizeSubscriptionUrls(config.subscriptionUrl).length === 0) {
    throw new Error(
      'Missing subscriptionUrl. Run `surge-vless-bridge init` and fill the config, or pass --subscription-url.',
    );
  }

  if (!config.surgeConfigPath) {
    throw new Error(
      'Missing surgeConfigPath. Run `surge-vless-bridge init` and fill the config, or pass --surge-config.',
    );
  }
};

const ensureWritableDirs = async (config: CliConfig) => {
  await mkdir(config.outputDir, { recursive: true });
  await mkdir(config.backupDir, { recursive: true });
};

const writeAnyTlsSidecar = async (config: CliConfig, entries: AnyTlsEntry[]) => {
  const sidecarPath = join(config.outputDir, ANYTLS_SIDECAR_FILE);
  await writeTextFile(sidecarPath, `${JSON.stringify(entries, null, 2)}\n`);
};

const readAnyTlsSidecar = async (config: CliConfig): Promise<AnyTlsEntry[]> => {
  const sidecarPath = join(config.outputDir, ANYTLS_SIDECAR_FILE);
  if (!(await pathExists(sidecarPath))) {
    return [];
  }
  try {
    const entries = await readJsonFile<AnyTlsEntry[]>(sidecarPath);
    return Array.isArray(entries) ? entries.filter((entry) => entry && entry.name && entry.line) : [];
  } catch {
    return [];
  }
};

export const backupSurgeProfile = async (config: CliConfig) => {
  await mkdir(config.backupDir, { recursive: true });

  const bytes = await readJsonCompatibleBinary(config.surgeConfigPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(config.backupDir, `${basename(config.surgeConfigPath, '.conf')}-${timestamp}.conf`);

  await writeBinaryFile(backupPath, bytes);
  return backupPath;
};

const updatePolicyGroup = ({
  surgeText,
  policyGroupName,
  nodeNames,
}: {
  surgeText: string;
  policyGroupName: string;
  nodeNames: string[];
}) => {
  const sectionPattern = /(\[Proxy Group\])([\s\S]*?)(?=\n\[|$)/;
  const groupPattern = new RegExp(`^${escapeRegExp(policyGroupName)}\\s*=.*$`, 'm');
  const groupLine = `${policyGroupName} = url-test, ${nodeNames.join(', ')}, no-alert=0, hidden=0`;

  return surgeText.replace(sectionPattern, (match, sectionTitle, sectionBody) => {
    if (groupPattern.test(sectionBody)) {
      return `${sectionTitle}${sectionBody.replace(groupPattern, groupLine)}`;
    }

    return `${match}\n${groupLine}`;
  });
};

const updateProxyBlock = ({ surgeText, proxyLines }: { surgeText: string; proxyLines: string[] }) => {
  const proxyStartMarker = '# vless start';
  const proxyEndMarker = '# vless end';

  const blockPattern = new RegExp(
    `(${escapeRegExp(proxyStartMarker)})([\\s\\S]*?)(${escapeRegExp(proxyEndMarker)})`,
    'm',
  );

  if (surgeText.includes(proxyStartMarker) && surgeText.includes(proxyEndMarker)) {
    return surgeText.replace(blockPattern, (_, start, __, end) => `${start}\n${proxyLines.join('\n')}\n${end}`);
  }

  const proxySectionPattern = /(\[Proxy\])([\s\S]*?)(?=\n\[|$)/;
  const proxyBlock = `\n${proxyStartMarker}\n${proxyLines.join('\n')}\n${proxyEndMarker}`;

  if (!proxySectionPattern.test(surgeText)) {
    throw new Error('Surge profile is missing the [Proxy] section.');
  }

  return surgeText.replace(proxySectionPattern, (match) => {
    const trimmed = match.replace(/\s*$/, '');
    return `${trimmed}${proxyBlock}\n`;
  });
};

/** Upsert a single `Key = ...` entry inside a named Surge section, creating the
 * section at the end of the file if it is missing. Idempotent. */
const upsertSectionEntry = (text: string, sectionName: string, entryKey: string, entryLine: string): string => {
  const sectionHeader = `[${sectionName}]`;
  const entryPattern = new RegExp(`^${escapeRegExp(entryKey)}\\s*=.*$`, 'm');

  if (text.includes(sectionHeader)) {
    const sectionPattern = new RegExp(`(\\[${escapeRegExp(sectionName)}\\])([\\s\\S]*?)(?=\\n\\[|$)`);
    return text.replace(sectionPattern, (_match, title: string, body: string) => {
      if (entryPattern.test(body)) {
        return `${title}${body.replace(entryPattern, entryLine)}`;
      }
      return `${title}\n${entryLine}${body}`;
    });
  }

  return `${text.replace(/\s*$/, '')}\n\n${sectionHeader}\n${entryLine}\n`;
};

const PANEL_ENTRY_KEY = 'AirportTraffic';
const PANEL_ENTRY_LINE = `${PANEL_ENTRY_KEY} = script-name=${PANEL_ENTRY_KEY}, update-interval=3600`;

/** Inject (or refresh) the traffic-panel [Panel]/[Script] entries into the
 * configured Surge profile. Backs the file up first. */
const injectPanelConfig = async (config: CliConfig, scriptPath: string): Promise<void> => {
  const target = config.panelInjectPath;
  if (!(await pathExists(target))) {
    throw new Error(`panelInjectPath does not exist: ${target}`);
  }

  await mkdir(config.backupDir, { recursive: true });
  const bytes = await readFile(target);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(config.backupDir, `${basename(target, '.conf')}-panel-${timestamp}.conf`);
  await writeBinaryFile(backupPath, bytes);

  const scriptLine = `${PANEL_ENTRY_KEY} = type=generic, script-path=${scriptPath}`;
  let text = bytes.toString('utf8');
  text = upsertSectionEntry(text, 'Script', PANEL_ENTRY_KEY, scriptLine);
  text = upsertSectionEntry(text, 'Panel', PANEL_ENTRY_KEY, PANEL_ENTRY_LINE);
  await writeTextFile(target, text);
};

const writeSurgeProfile = async ({
  config,
  proxyLines,
  nodeNames,
}: {
  config: CliConfig;
  proxyLines: string[];
  nodeNames: string[];
}) => {
  const source = await readTextFile(config.surgeConfigPath);
  const withProxyBlock = updateProxyBlock({
    surgeText: source,
    proxyLines,
  });
  const withPolicyGroup = updatePolicyGroup({
    surgeText: withProxyBlock,
    policyGroupName: config.policyGroupName,
    nodeNames,
  });

  await writeTextFile(config.surgeConfigPath, withPolicyGroup);
};

const generateConfigsFromOutbounds = async ({
  outbounds,
  config,
}: {
  outbounds: SingBoxVlessOutbound[];
  config: CliConfig;
}) => {
  await ensureWritableDirs(config);

  const generated = await Promise.all(
    outbounds.map(async (outbound, index) => {
      const port = config.portStart + index;
      // Names are already sanitized + de-duplicated by the caller.
      const nodeName = outbound.tag;
      const configPath = join(config.outputDir, `sing-box[${port}].json`);
      const serverConfig = parseTemplate({
        node: {
          ...outbound,
          tag: nodeName,
        },
        port,
      });

      await writeTextFile(configPath, `${JSON.stringify(serverConfig, null, 2)}\n`);

      return {
        nodeName,
        port,
        configPath,
        server: outbound.server,
      } satisfies GeneratedNode;
    }),
  );

  const proxyLines = await Promise.all(
    generated.map((entry) =>
      buildExternalProxyLine({
        ...entry,
        singBoxBinary: config.singBoxBinary,
        addressResolver: config.addressResolver,
      }),
    ),
  );

  return {
    generated,
    proxyLines,
    nodeNames: generated.map((entry) => entry.nodeName),
  };
};

export const syncSubscriptionToSurge = async (config: CliConfig) => {
  ensureRequiredConfig(config);

  const subscriptionUrls = normalizeSubscriptionUrls(config.subscriptionUrl);
  const collected = await collectSubscriptionProxies({
    subscriptionUrls,
    requestHeaders: config.requestHeaders,
    subscriptionOutputPath: config.subscriptionOutputPath,
  });

  // Assign globally-unique, sanitized policy names across BOTH protocols so
  // Surge never sees a duplicate proxy name (common when merging subscriptions).
  const seen = new Set<string>();
  collected.vlessOutbounds.forEach((outbound, index) => {
    outbound.tag = uniquePolicyName(outbound.tag, index, seen);
  });
  const anytlsNamed = collected.anytlsProxies.map((proxy, index) => ({
    proxy,
    name: uniquePolicyName(String(proxy.name ?? `anytls-${index + 1}`), index, seen),
  }));

  // vless -> sing-box external (also creates outputDir/backupDir).
  const generated = await generateConfigsFromOutbounds({ outbounds: collected.vlessOutbounds, config });

  // anytls -> native Surge proxy lines, persisted for `rebuild`.
  const anytlsEntries: AnyTlsEntry[] = anytlsNamed.map(({ proxy, name }, index) => ({
    name,
    line: buildAnyTlsLine(proxy, name, index),
  }));
  await writeAnyTlsSidecar(config, anytlsEntries);

  const proxyLines = [...generated.proxyLines, ...anytlsEntries.map((entry) => entry.line)];
  const nodeNames = [...generated.nodeNames, ...anytlsEntries.map((entry) => entry.name)];

  if (nodeNames.length === 0) {
    throw new Error('No supported nodes (vless/anytls) found in the subscription(s).');
  }

  const backupPath = await backupSurgeProfile(config);
  await writeSurgeProfile({ config, proxyLines, nodeNames });

  // Generate a Surge panel script (with the private URLs) so the airport's
  // traffic usage can be shown in the Surge dashboard.
  const trafficPanelPath = join(config.outputDir, TRAFFIC_PANEL_FILE);
  await writeTextFile(trafficPanelPath, buildAirportTrafficScript(subscriptionUrls));

  // If an inject target is configured, auto-add the [Panel]/[Script] entries.
  let panelInjected = false;
  if (config.panelInjectPath) {
    await injectPanelConfig(config, trafficPanelPath);
    panelInjected = true;
  }

  if (collected.skipped.length > 0) {
    const types = [...new Set(collected.skipped.map((item) => item.type))].join(', ');
    console.warn(`Skipped ${collected.skipped.length} unsupported node(s): ${types}`);
  }

  return {
    backupPath,
    trafficPanelPath,
    panelInjected,
    panelInjectPath: config.panelInjectPath,
    count: nodeNames.length,
    vlessCount: generated.nodeNames.length,
    anytlsCount: anytlsEntries.length,
    skippedCount: collected.skipped.length,
  };
};

export const rebuildSurgeFromLocalConfigs = async (config: CliConfig) => {
  if (!config.surgeConfigPath) {
    throw new Error(
      'Missing surgeConfigPath. Run `surge-vless-bridge init` and fill the config, or pass --surge-config.',
    );
  }

  const dirEntries = await readdir(config.outputDir).catch(() => [] as string[]);
  const entries = dirEntries
    .filter((entry) => /^sing-box\[\d+\]\.json$/.test(entry))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  const generated = await Promise.all(
    entries.map(async (entry) => {
      const match = entry.match(/sing-box\[(\d+)\]\.json$/);
      if (!match) {
        return null;
      }

      const port = Number(match[1]);
      const configPath = join(config.outputDir, entry);
      const json = await readJsonFile<SingBoxConfig>(configPath);
      const outbound = json.outbounds?.[0];
      const rawTag = outbound?.tag;
      const nodeName = rawTag
        ?.replace(/[,\n\r=]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!nodeName || !outbound?.server) {
        console.error(`Skipping unusable config: ${configPath}`);
        return null;
      }

      return {
        nodeName,
        port,
        configPath,
        server: outbound.server,
      } satisfies GeneratedNode;
    }),
  );

  const validEntries = generated.filter((entry): entry is GeneratedNode => Boolean(entry));

  const vlessLines = await Promise.all(
    validEntries.map((entry) =>
      buildExternalProxyLine({
        ...entry,
        singBoxBinary: config.singBoxBinary,
        addressResolver: config.addressResolver,
      }),
    ),
  );

  const anytlsEntries = await readAnyTlsSidecar(config);

  const proxyLines = [...vlessLines, ...anytlsEntries.map((entry) => entry.line)];
  const nodeNames = [...validEntries.map((entry) => entry.nodeName), ...anytlsEntries.map((entry) => entry.name)];

  if (nodeNames.length === 0) {
    throw new Error(`No usable local nodes found in ${config.outputDir}. Run \`sync\` first.`);
  }

  const backupPath = await backupSurgeProfile(config);
  await writeSurgeProfile({ config, proxyLines, nodeNames });

  return {
    backupPath,
    count: nodeNames.length,
    vlessCount: validEntries.length,
    anytlsCount: anytlsEntries.length,
  };
};

export const restoreSurgeProfileBackup = async ({ config, backupPath }: { config: CliConfig; backupPath?: string }) => {
  const resolvedBackupPath = backupPath ? resolve(backupPath) : undefined;
  const targetPath = resolvedBackupPath ?? (await findLatestBackup(config.backupDir));

  if (!targetPath) {
    throw new Error(`No backup files found in ${config.backupDir}`);
  }

  await writeBinaryFile(config.surgeConfigPath, await readJsonCompatibleBinary(targetPath));
  return targetPath;
};

const readJsonCompatibleBinary = (path: string) => readFile(path);

const findLatestBackup = async (backupDir: string) => {
  try {
    const entries = await readdir(backupDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.conf'))
      .map((entry) => join(backupDir, entry.name))
      .sort((left, right) => right.localeCompare(left));
    return files[0];
  } catch {
    return undefined;
  }
};

export const runDoctor = async (config: CliConfig) => {
  const subscriptionUrls = normalizeSubscriptionUrls(config.subscriptionUrl);

  const checks = [
    ['subscriptionUrl', subscriptionUrls.length > 0, subscriptionUrls.length ? `${subscriptionUrls.length} url(s)` : 'missing'],
    [
      'surgeConfigPath',
      Boolean(config.surgeConfigPath) && (await pathExists(config.surgeConfigPath)),
      config.surgeConfigPath || 'missing',
    ],
    [
      'singBoxBinary',
      Boolean(config.singBoxBinary) && (await pathExists(config.singBoxBinary)),
      config.singBoxBinary || 'missing',
    ],
    ['outputDir', true, config.outputDir],
    ['backupDir', true, config.backupDir],
  ] as const;

  for (const [label, ok, value] of checks) {
    console.log(`${ok ? 'OK' : 'FAIL'} ${label}: ${value}`);
  }

  for (const url of subscriptionUrls) {
    console.log(`   - ${url}`);
  }

  if (config.surgeConfigPath) {
    if (await pathExists(config.surgeConfigPath)) {
      const text = await readTextFile(config.surgeConfigPath);

      console.log(`${text.includes('[Proxy Group]') ? 'OK' : 'FAIL'} proxy-group-section: [Proxy Group]`);
      console.log(`${text.includes('[Proxy]') ? 'OK' : 'FAIL'} proxy-section: [Proxy]`);
    }
  }
};
