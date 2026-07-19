"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectSubscriptionProxies = exports.normalizeSubscriptionUrls = void 0;
const fs_1 = require("./utils/fs");
const decode_subscription_1 = require("./utils/decode-subscription");
const parse_clash_1 = require("./utils/parse-clash");
const clash_vless_to_outbound_1 = require("./utils/clash-vless-to-outbound");
const parse_vless_node_1 = require("./utils/parse-vless-node");
/** Normalize the configured subscription URL(s) into a plain string list.
 * Accepts a single string, a comma/newline separated string, or an array. */
const normalizeSubscriptionUrls = (input) => {
    if (!input) {
        return [];
    }
    const list = Array.isArray(input) ? input : input.split(/[\n,]/);
    return list.map((url) => url.trim()).filter((url) => url !== '');
};
exports.normalizeSubscriptionUrls = normalizeSubscriptionUrls;
const fetchSubscriptionText = async (subscriptionUrl, requestHeaders) => {
    const response = await fetch(subscriptionUrl, { headers: requestHeaders });
    if (!response.ok) {
        throw new Error(`Failed to fetch subscription ${subscriptionUrl}: ${response.status} ${response.statusText}`);
    }
    return response.text();
};
/** Parse one subscription payload (Clash YAML or legacy base64/vless list)
 * into the collected buckets, appending into the provided accumulator. */
const ingestSubscription = (rawData, acc) => {
    if ((0, parse_clash_1.looksLikeClashYaml)(rawData)) {
        const proxies = (0, parse_clash_1.parseClashProxies)(rawData);
        proxies.forEach((proxy, index) => {
            const type = String(proxy.type ?? '');
            if (type === 'vless') {
                acc.vlessOutbounds.push((0, clash_vless_to_outbound_1.clashVlessToOutbound)(proxy, index));
            }
            else if (type === 'anytls') {
                acc.anytlsProxies.push(proxy);
            }
            else {
                acc.skipped.push({ name: String(proxy.name ?? `node${index + 1}`), type: type || 'unknown' });
            }
        });
        return;
    }
    // Legacy path: base64-encoded (or plain) list of `scheme://` URIs. Only
    // vless is understood here, matching the original tool's behaviour.
    const decoded = (0, decode_subscription_1.decodeSubscription)(rawData);
    const lines = decoded.split('\n').filter((line) => line.trim() !== '');
    const vlessLines = lines.filter((line) => line.startsWith('vless://'));
    vlessLines.forEach((line, index) => {
        acc.vlessOutbounds.push((0, parse_vless_node_1.parseVlessNode)(line, index));
    });
    const skippedSchemes = lines.filter((line) => /^[a-z0-9]+:\/\//i.test(line) && !line.startsWith('vless://'));
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
const collectSubscriptionProxies = async ({ subscriptionUrls, requestHeaders, subscriptionOutputPath, }) => {
    const acc = { vlessOutbounds: [], anytlsProxies: [], skipped: [] };
    for (const url of subscriptionUrls) {
        const rawData = await fetchSubscriptionText(url, requestHeaders);
        ingestSubscription(rawData, acc);
    }
    if (subscriptionOutputPath) {
        const summary = [
            ...acc.vlessOutbounds.map((o) => `vless\t${o.tag}\t${o.server}:${o.server_port}`),
            ...acc.anytlsProxies.map((p) => `anytls\t${p.name}\t${p.server}:${p.port}`),
        ].join('\n');
        await (0, fs_1.writeTextFile)(subscriptionOutputPath, `${summary}\n`);
    }
    return acc;
};
exports.collectSubscriptionProxies = collectSubscriptionProxies;
//# sourceMappingURL=parse.js.map