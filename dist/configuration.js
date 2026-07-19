"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeExampleConfig = exports.loadCliConfig = exports.getDefaultConfig = exports.HOME_CONFIG_FILE_PATH = exports.CONFIG_FILE_NAME = void 0;
const promises_1 = require("node:fs/promises");
const node_child_process_1 = require("node:child_process");
const node_path_1 = require("node:path");
const fs_1 = require("./utils/fs");
exports.CONFIG_FILE_NAME = '.surge-vless-bridge.json';
exports.HOME_CONFIG_FILE_PATH = (0, node_path_1.join)('.config', 'surge-vless-bridge', 'config.json');
// Request the subscription as a Clash / mihomo client. Panels serve their
// Clash YAML (which includes anytls and every other protocol) to this UA; a
// browser-like UA makes some panels return an HTML preview page instead, and a
// v2ray UA drops anytls nodes. The legacy base64 path still works for providers
// that ignore the UA.
const DEFAULT_HEADERS = {
    accept: '*/*',
    'user-agent': 'clash-verge/v1.7.0',
};
const DEFAULT_ADDRESS_RESOLVER = {
    strategy: 'system',
    dohEndpoint: 'https://1.1.1.1/dns-query',
    dnsServers: ['1.1.1.1', '8.8.8.8'],
    filterSurgeFakeIp: true,
};
const detectSingBoxBinary = async () => {
    const result = (0, node_child_process_1.spawnSync)('which', ['sing-box'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0) {
        const binaryPath = result.stdout.trim();
        return {
            path: binaryPath,
            exists: Boolean(binaryPath),
        };
    }
    const fallbackPath = '/opt/homebrew/bin/sing-box';
    return {
        path: fallbackPath,
        exists: await (0, fs_1.pathExists)(fallbackPath),
    };
};
const detectSurgeConfigPath = async () => {
    const home = process.env.HOME;
    if (!home) {
        return '';
    }
    const profilesDir = (0, node_path_1.join)(home, 'Library/Application Support/Surge/Profiles');
    try {
        const entries = await (0, promises_1.readdir)(profilesDir, { withFileTypes: true });
        const candidates = entries
            .filter((entry) => entry.isFile() && entry.name.endsWith('.conf'))
            .map((entry) => (0, node_path_1.join)(profilesDir, entry.name));
        if (candidates.length === 1) {
            return candidates[0] ?? '';
        }
        const sortedByMtime = await Promise.all(candidates.map(async (candidate) => ({
            path: candidate,
            mtimeMs: (await (0, promises_1.stat)(candidate)).mtimeMs,
        })));
        sortedByMtime.sort((left, right) => {
            if (right.mtimeMs !== left.mtimeMs) {
                return right.mtimeMs - left.mtimeMs;
            }
            return right.path.localeCompare(left.path);
        });
        return sortedByMtime[0]?.path ?? '';
    }
    catch {
        return '';
    }
};
const getDefaultConfig = async (_cwd) => {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
    const stateDir = (0, node_path_1.join)(home, '.config', 'surge-vless-bridge');
    const singBoxBinary = await detectSingBoxBinary();
    return {
        subscriptionUrl: '',
        surgeConfigPath: await detectSurgeConfigPath(),
        singBoxBinary: singBoxBinary.path,
        outputDir: (0, node_path_1.join)(stateDir, 'nodes'),
        backupDir: (0, node_path_1.join)(stateDir, 'backups'),
        policyGroupName: 'VLESS',
        proxyStartMarker: '# vless start',
        proxyEndMarker: '# vless end',
        portStart: 2081,
        subscriptionOutputPath: (0, node_path_1.join)(stateDir, 'vless_nodes.txt'),
        requestHeaders: { ...DEFAULT_HEADERS },
        addressResolver: { ...DEFAULT_ADDRESS_RESOLVER },
    };
};
exports.getDefaultConfig = getDefaultConfig;
const resolveGitRoot = (cwd) => {
    const result = (0, node_child_process_1.spawnSync)('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status === 0) {
        return result.stdout.trim() || undefined;
    }
    return undefined;
};
const resolveDefaultConfigPath = (cwd) => {
    const gitRoot = resolveGitRoot(cwd);
    if (gitRoot) {
        return (0, node_path_1.join)(gitRoot, exports.CONFIG_FILE_NAME);
    }
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (home) {
        return (0, node_path_1.join)(home, exports.HOME_CONFIG_FILE_PATH);
    }
    return (0, node_path_1.resolve)(cwd, exports.CONFIG_FILE_NAME);
};
const mergeConfig = (base, input) => {
    if (!input) {
        return base;
    }
    const definedEntries = Object.entries(input).filter(([, value]) => value !== undefined);
    const sanitizedInput = Object.fromEntries(definedEntries);
    const addressResolverInput = typeof sanitizedInput.addressResolver === 'string'
        ? { strategy: sanitizedInput.addressResolver }
        : sanitizedInput.addressResolver;
    return {
        ...base,
        ...sanitizedInput,
        requestHeaders: {
            ...base.requestHeaders,
            ...(sanitizedInput.requestHeaders ?? {}),
        },
        addressResolver: {
            ...base.addressResolver,
            ...(addressResolverInput ?? {}),
        },
    };
};
const loadCliConfig = async ({ cwd, configPath, overrides, }) => {
    const defaults = await (0, exports.getDefaultConfig)(cwd);
    const resolvedConfigPath = configPath ? (0, node_path_1.resolve)(cwd, configPath) : resolveDefaultConfigPath(cwd);
    if (!(await (0, fs_1.pathExists)(resolvedConfigPath))) {
        return {
            config: mergeConfig(defaults, overrides),
            configPath: resolvedConfigPath,
            exists: false,
        };
    }
    const parsed = await (0, fs_1.readJsonFile)(resolvedConfigPath);
    return {
        config: mergeConfig(mergeConfig(defaults, parsed), overrides),
        configPath: resolvedConfigPath,
        exists: true,
    };
};
exports.loadCliConfig = loadCliConfig;
const writeExampleConfig = async ({ cwd, configPath, force, }) => {
    const defaults = await (0, exports.getDefaultConfig)(cwd);
    const singBoxBinary = await detectSingBoxBinary();
    const resolvedConfigPath = configPath ? (0, node_path_1.resolve)(cwd, configPath) : resolveDefaultConfigPath(cwd);
    if (!force && (await (0, fs_1.pathExists)(resolvedConfigPath))) {
        throw new Error(`Config file already exists: ${resolvedConfigPath}`);
    }
    const example = {
        // A single URL string, or an array to merge multiple subscriptions.
        subscriptionUrl: [''],
        surgeConfigPath: defaults.surgeConfigPath,
        policyGroupName: defaults.policyGroupName,
        portStart: defaults.portStart,
    };
    await (0, fs_1.writeTextFile)(resolvedConfigPath, `${JSON.stringify(example, null, 2)}\n`);
    return {
        configPath: resolvedConfigPath,
        warnings: singBoxBinary.exists
            ? []
            : [
                `sing-box not found. Install it first(brew install sing-box), or update singBoxBinary manually: ${singBoxBinary.path}`,
            ],
    };
};
exports.writeExampleConfig = writeExampleConfig;
//# sourceMappingURL=configuration.js.map