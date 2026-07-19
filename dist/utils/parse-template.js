"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTemplate = void 0;
const parseTemplate = ({ node, port, }) => {
    return {
        log: {
            level: 'error',
            timestamp: true,
        },
        inbounds: [
            {
                type: 'socks',
                tag: 'socks-in',
                listen: '127.0.0.1',
                listen_port: port,
            },
        ],
        outbounds: (Array.isArray(node) ? node : [node]).map((item) => ({ ...item })),
        route: {
            final: Array.isArray(node) ? node?.[0]?.tag : node.tag,
        },
    };
};
exports.parseTemplate = parseTemplate;
//# sourceMappingURL=parse-template.js.map