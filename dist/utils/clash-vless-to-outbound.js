"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clashVlessToOutbound = void 0;
const asString = (value) => value === undefined || value === null ? undefined : String(value);
const asBoolean = (value) => value === true || value === 'true';
/**
 * Convert a Clash/mihomo `type: vless` proxy into the sing-box outbound the
 * bridge feeds to `sing-box run`. Mirrors the structure produced by the
 * original vless:// parser (alpn http/1.1 + uTLS + reality) which is known to
 * work with reality-vision nodes.
 */
const clashVlessToOutbound = (proxy, index) => {
    const server = asString(proxy.server);
    const uuid = asString(proxy.uuid);
    const port = Number(proxy.port);
    if (!server || !uuid || Number.isNaN(port)) {
        throw new Error(`Invalid clash vless node at index ${index + 1}: ${JSON.stringify(proxy)}`);
    }
    const tag = asString(proxy.name) || `vless-${index + 1}`;
    const flow = asString(proxy.flow);
    const network = asString(proxy.network);
    const tls = asBoolean(proxy.tls);
    const sni = asString(proxy.servername) ?? asString(proxy.sni);
    const clientFingerprint = asString(proxy['client-fingerprint']) ?? 'chrome';
    const realityOpts = proxy['reality-opts'];
    const outbound = {
        type: 'vless',
        tag,
        server,
        server_port: port,
        uuid,
    };
    if (flow) {
        outbound.flow = flow;
    }
    if (network && network !== 'tcp') {
        outbound.network = network;
    }
    // vless always carries TLS in practice; keep the reality/uTLS block whenever
    // the node advertises tls or a reality config.
    if (tls || realityOpts) {
        outbound.tls = {
            enabled: true,
            insecure: asBoolean(proxy['skip-cert-verify']),
            alpn: ['http/1.1'],
            record_fragment: false,
            utls: {
                enabled: true,
                fingerprint: clientFingerprint,
            },
        };
        if (sni) {
            outbound.tls.server_name = sni;
        }
        if (realityOpts) {
            const publicKey = asString(realityOpts['public-key']);
            const shortId = asString(realityOpts['short-id']);
            if (publicKey) {
                outbound.tls.reality = {
                    enabled: true,
                    public_key: publicKey,
                    short_id: shortId,
                };
            }
        }
    }
    return outbound;
};
exports.clashVlessToOutbound = clashVlessToOutbound;
//# sourceMappingURL=clash-vless-to-outbound.js.map