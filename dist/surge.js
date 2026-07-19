"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runDoctor = exports.restoreSurgeProfileBackup = exports.rebuildSurgeFromLocalConfigs = exports.syncSubscriptionToSurge = exports.backupSurgeProfile = void 0;
const promises_1 = require("node:dns/promises");
const promises_2 = require("node:fs/promises");
const node_net_1 = require("node:net");
const node_path_1 = require("node:path");
const parse_1 = require("./parse");
const parse_template_1 = require("./utils/parse-template");
const fs_1 = require("./utils/fs");
const build_anytls_line_1 = require("./utils/build-anytls-line");
const policy_name_1 = require("./utils/policy-name");
const panel_script_1 = require("./utils/panel-script");
/** Filename of the generated Surge traffic-panel script inside `outputDir`. */
const TRAFFIC_PANEL_FILE = 'airport-traffic.js';
const DOH_RECORD_TYPES = {
    A: 1,
    AAAA: 28,
};
/** Sidecar file storing the anytls native proxy lines, so `rebuild` can
 * regenerate them without re-fetching (they have no sing-box config of their
 * own, unlike vless nodes). */
const ANYTLS_SIDECAR_FILE = 'anytls-nodes.json';
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isSurgeFakeIp = (address) => {
    if ((0, node_net_1.isIP)(address) !== 4) {
        return false;
    }
    const [first, second] = address.split('.').map((part) => Number(part));
    return first === 198 && (second === 18 || second === 19);
};
const uniqueRealAddresses = (addresses, resolverConfig) => [
    ...new Set(addresses.filter((address) => (0, node_net_1.isIP)(address) && (!resolverConfig.filterSurgeFakeIp || !isSurgeFakeIp(address)))),
];
const resolveWithSystem = async (server) => {
    const records = await (0, promises_1.lookup)(server, { all: true });
    return records.map((record) => record.address);
};
const resolveWithDnsServers = async (server, dnsServers) => {
    const resolver = new promises_1.Resolver();
    if (dnsServers.length > 0) {
        resolver.setServers(dnsServers);
    }
    const settled = await Promise.allSettled([resolver.resolve4(server), resolver.resolve6(server)]);
    return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
};
const queryDohAddresses = async (server, recordType, dohEndpoint) => {
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
    const payload = (await response.json());
    if (!Array.isArray(payload.Answer)) {
        return [];
    }
    const answerType = DOH_RECORD_TYPES[recordType];
    return payload.Answer.filter((answer) => answer.type === answerType && typeof answer.data === 'string').map((answer) => answer.data);
};
const resolveWithDoh = async (server, dohEndpoint) => {
    const settled = await Promise.allSettled([
        queryDohAddresses(server, 'A', dohEndpoint),
        queryDohAddresses(server, 'AAAA', dohEndpoint),
    ]);
    return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
};
const resolveAddresses = async (server, resolverConfig) => {
    if (resolverConfig.strategy === 'off') {
        return [];
    }
    if ((0, node_net_1.isIP)(server)) {
        return uniqueRealAddresses([server], resolverConfig);
    }
    try {
        if (resolverConfig.strategy === 'doh') {
            const dohAddresses = uniqueRealAddresses(await resolveWithDoh(server, resolverConfig.dohEndpoint), resolverConfig);
            if (dohAddresses.length > 0) {
                return dohAddresses;
            }
            return uniqueRealAddresses(await resolveWithDnsServers(server, resolverConfig.dnsServers), resolverConfig);
        }
        if (resolverConfig.strategy === 'dns') {
            return uniqueRealAddresses(await resolveWithDnsServers(server, resolverConfig.dnsServers), resolverConfig);
        }
        return uniqueRealAddresses(await resolveWithSystem(server), resolverConfig);
    }
    catch (error) {
        console.error(`Failed to resolve ${server}:`, error);
        return [];
    }
};
const buildExternalProxyLine = async ({ nodeName, port, configPath, server, singBoxBinary, addressResolver, }) => {
    const addresses = await resolveAddresses(server, addressResolver);
    const addressArg = addresses.length > 0 ? `, addresses=${addresses[0]}` : '';
    return `${nodeName} = external, exec=${singBoxBinary}, args=run, args=-c, args=${configPath}, local-port=${port}${addressArg}`;
};
const ensureRequiredConfig = (config) => {
    if ((0, parse_1.normalizeSubscriptionUrls)(config.subscriptionUrl).length === 0) {
        throw new Error('Missing subscriptionUrl. Run `surge-vless-bridge init` and fill the config, or pass --subscription-url.');
    }
    if (!config.surgeConfigPath) {
        throw new Error('Missing surgeConfigPath. Run `surge-vless-bridge init` and fill the config, or pass --surge-config.');
    }
};
const ensureWritableDirs = async (config) => {
    await (0, promises_2.mkdir)(config.outputDir, { recursive: true });
    await (0, promises_2.mkdir)(config.backupDir, { recursive: true });
};
const writeAnyTlsSidecar = async (config, entries) => {
    const sidecarPath = (0, node_path_1.join)(config.outputDir, ANYTLS_SIDECAR_FILE);
    await (0, fs_1.writeTextFile)(sidecarPath, `${JSON.stringify(entries, null, 2)}\n`);
};
const readAnyTlsSidecar = async (config) => {
    const sidecarPath = (0, node_path_1.join)(config.outputDir, ANYTLS_SIDECAR_FILE);
    if (!(await (0, fs_1.pathExists)(sidecarPath))) {
        return [];
    }
    try {
        const entries = await (0, fs_1.readJsonFile)(sidecarPath);
        return Array.isArray(entries) ? entries.filter((entry) => entry && entry.name && entry.line) : [];
    }
    catch {
        return [];
    }
};
const backupSurgeProfile = async (config) => {
    await (0, promises_2.mkdir)(config.backupDir, { recursive: true });
    const bytes = await readJsonCompatibleBinary(config.surgeConfigPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = (0, node_path_1.join)(config.backupDir, `${(0, node_path_1.basename)(config.surgeConfigPath, '.conf')}-${timestamp}.conf`);
    await (0, fs_1.writeBinaryFile)(backupPath, bytes);
    return backupPath;
};
exports.backupSurgeProfile = backupSurgeProfile;
const updatePolicyGroup = ({ surgeText, policyGroupName, nodeNames, }) => {
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
const updateProxyBlock = ({ surgeText, proxyLines }) => {
    const proxyStartMarker = '# vless start';
    const proxyEndMarker = '# vless end';
    const blockPattern = new RegExp(`(${escapeRegExp(proxyStartMarker)})([\\s\\S]*?)(${escapeRegExp(proxyEndMarker)})`, 'm');
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
const writeSurgeProfile = async ({ config, proxyLines, nodeNames, }) => {
    const source = await (0, fs_1.readTextFile)(config.surgeConfigPath);
    const withProxyBlock = updateProxyBlock({
        surgeText: source,
        proxyLines,
    });
    const withPolicyGroup = updatePolicyGroup({
        surgeText: withProxyBlock,
        policyGroupName: config.policyGroupName,
        nodeNames,
    });
    await (0, fs_1.writeTextFile)(config.surgeConfigPath, withPolicyGroup);
};
const generateConfigsFromOutbounds = async ({ outbounds, config, }) => {
    await ensureWritableDirs(config);
    const generated = await Promise.all(outbounds.map(async (outbound, index) => {
        const port = config.portStart + index;
        // Names are already sanitized + de-duplicated by the caller.
        const nodeName = outbound.tag;
        const configPath = (0, node_path_1.join)(config.outputDir, `sing-box[${port}].json`);
        const serverConfig = (0, parse_template_1.parseTemplate)({
            node: {
                ...outbound,
                tag: nodeName,
            },
            port,
        });
        await (0, fs_1.writeTextFile)(configPath, `${JSON.stringify(serverConfig, null, 2)}\n`);
        return {
            nodeName,
            port,
            configPath,
            server: outbound.server,
        };
    }));
    const proxyLines = await Promise.all(generated.map((entry) => buildExternalProxyLine({
        ...entry,
        singBoxBinary: config.singBoxBinary,
        addressResolver: config.addressResolver,
    })));
    return {
        generated,
        proxyLines,
        nodeNames: generated.map((entry) => entry.nodeName),
    };
};
const syncSubscriptionToSurge = async (config) => {
    ensureRequiredConfig(config);
    const subscriptionUrls = (0, parse_1.normalizeSubscriptionUrls)(config.subscriptionUrl);
    const collected = await (0, parse_1.collectSubscriptionProxies)({
        subscriptionUrls,
        requestHeaders: config.requestHeaders,
        subscriptionOutputPath: config.subscriptionOutputPath,
    });
    // Assign globally-unique, sanitized policy names across BOTH protocols so
    // Surge never sees a duplicate proxy name (common when merging subscriptions).
    const seen = new Set();
    collected.vlessOutbounds.forEach((outbound, index) => {
        outbound.tag = (0, policy_name_1.uniquePolicyName)(outbound.tag, index, seen);
    });
    const anytlsNamed = collected.anytlsProxies.map((proxy, index) => ({
        proxy,
        name: (0, policy_name_1.uniquePolicyName)(String(proxy.name ?? `anytls-${index + 1}`), index, seen),
    }));
    // vless -> sing-box external (also creates outputDir/backupDir).
    const generated = await generateConfigsFromOutbounds({ outbounds: collected.vlessOutbounds, config });
    // anytls -> native Surge proxy lines, persisted for `rebuild`.
    const anytlsEntries = anytlsNamed.map(({ proxy, name }, index) => ({
        name,
        line: (0, build_anytls_line_1.buildAnyTlsLine)(proxy, name, index),
    }));
    await writeAnyTlsSidecar(config, anytlsEntries);
    const proxyLines = [...generated.proxyLines, ...anytlsEntries.map((entry) => entry.line)];
    const nodeNames = [...generated.nodeNames, ...anytlsEntries.map((entry) => entry.name)];
    if (nodeNames.length === 0) {
        throw new Error('No supported nodes (vless/anytls) found in the subscription(s).');
    }
    const backupPath = await (0, exports.backupSurgeProfile)(config);
    await writeSurgeProfile({ config, proxyLines, nodeNames });
    // Generate a Surge panel script (with the private URLs) so the airport's
    // traffic usage can be shown in the Surge dashboard.
    const trafficPanelPath = (0, node_path_1.join)(config.outputDir, TRAFFIC_PANEL_FILE);
    await (0, fs_1.writeTextFile)(trafficPanelPath, (0, panel_script_1.buildAirportTrafficScript)(subscriptionUrls));
    if (collected.skipped.length > 0) {
        const types = [...new Set(collected.skipped.map((item) => item.type))].join(', ');
        console.warn(`Skipped ${collected.skipped.length} unsupported node(s): ${types}`);
    }
    return {
        backupPath,
        trafficPanelPath,
        count: nodeNames.length,
        vlessCount: generated.nodeNames.length,
        anytlsCount: anytlsEntries.length,
        skippedCount: collected.skipped.length,
    };
};
exports.syncSubscriptionToSurge = syncSubscriptionToSurge;
const rebuildSurgeFromLocalConfigs = async (config) => {
    if (!config.surgeConfigPath) {
        throw new Error('Missing surgeConfigPath. Run `surge-vless-bridge init` and fill the config, or pass --surge-config.');
    }
    const dirEntries = await (0, promises_2.readdir)(config.outputDir).catch(() => []);
    const entries = dirEntries
        .filter((entry) => /^sing-box\[\d+\]\.json$/.test(entry))
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    const generated = await Promise.all(entries.map(async (entry) => {
        const match = entry.match(/sing-box\[(\d+)\]\.json$/);
        if (!match) {
            return null;
        }
        const port = Number(match[1]);
        const configPath = (0, node_path_1.join)(config.outputDir, entry);
        const json = await (0, fs_1.readJsonFile)(configPath);
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
        };
    }));
    const validEntries = generated.filter((entry) => Boolean(entry));
    const vlessLines = await Promise.all(validEntries.map((entry) => buildExternalProxyLine({
        ...entry,
        singBoxBinary: config.singBoxBinary,
        addressResolver: config.addressResolver,
    })));
    const anytlsEntries = await readAnyTlsSidecar(config);
    const proxyLines = [...vlessLines, ...anytlsEntries.map((entry) => entry.line)];
    const nodeNames = [...validEntries.map((entry) => entry.nodeName), ...anytlsEntries.map((entry) => entry.name)];
    if (nodeNames.length === 0) {
        throw new Error(`No usable local nodes found in ${config.outputDir}. Run \`sync\` first.`);
    }
    const backupPath = await (0, exports.backupSurgeProfile)(config);
    await writeSurgeProfile({ config, proxyLines, nodeNames });
    return {
        backupPath,
        count: nodeNames.length,
        vlessCount: validEntries.length,
        anytlsCount: anytlsEntries.length,
    };
};
exports.rebuildSurgeFromLocalConfigs = rebuildSurgeFromLocalConfigs;
const restoreSurgeProfileBackup = async ({ config, backupPath }) => {
    const resolvedBackupPath = backupPath ? (0, node_path_1.resolve)(backupPath) : undefined;
    const targetPath = resolvedBackupPath ?? (await findLatestBackup(config.backupDir));
    if (!targetPath) {
        throw new Error(`No backup files found in ${config.backupDir}`);
    }
    await (0, fs_1.writeBinaryFile)(config.surgeConfigPath, await readJsonCompatibleBinary(targetPath));
    return targetPath;
};
exports.restoreSurgeProfileBackup = restoreSurgeProfileBackup;
const readJsonCompatibleBinary = (path) => (0, promises_2.readFile)(path);
const findLatestBackup = async (backupDir) => {
    try {
        const entries = await (0, promises_2.readdir)(backupDir, { withFileTypes: true });
        const files = entries
            .filter((entry) => entry.isFile() && entry.name.endsWith('.conf'))
            .map((entry) => (0, node_path_1.join)(backupDir, entry.name))
            .sort((left, right) => right.localeCompare(left));
        return files[0];
    }
    catch {
        return undefined;
    }
};
const runDoctor = async (config) => {
    const subscriptionUrls = (0, parse_1.normalizeSubscriptionUrls)(config.subscriptionUrl);
    const checks = [
        ['subscriptionUrl', subscriptionUrls.length > 0, subscriptionUrls.length ? `${subscriptionUrls.length} url(s)` : 'missing'],
        [
            'surgeConfigPath',
            Boolean(config.surgeConfigPath) && (await (0, fs_1.pathExists)(config.surgeConfigPath)),
            config.surgeConfigPath || 'missing',
        ],
        [
            'singBoxBinary',
            Boolean(config.singBoxBinary) && (await (0, fs_1.pathExists)(config.singBoxBinary)),
            config.singBoxBinary || 'missing',
        ],
        ['outputDir', true, config.outputDir],
        ['backupDir', true, config.backupDir],
    ];
    for (const [label, ok, value] of checks) {
        console.log(`${ok ? 'OK' : 'FAIL'} ${label}: ${value}`);
    }
    for (const url of subscriptionUrls) {
        console.log(`   - ${url}`);
    }
    if (config.surgeConfigPath) {
        if (await (0, fs_1.pathExists)(config.surgeConfigPath)) {
            const text = await (0, fs_1.readTextFile)(config.surgeConfigPath);
            console.log(`${text.includes('[Proxy Group]') ? 'OK' : 'FAIL'} proxy-group-section: [Proxy Group]`);
            console.log(`${text.includes('[Proxy]') ? 'OK' : 'FAIL'} proxy-section: [Proxy]`);
        }
    }
};
exports.runDoctor = runDoctor;
//# sourceMappingURL=surge.js.map