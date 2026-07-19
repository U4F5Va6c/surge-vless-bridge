#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const configuration_1 = require("./configuration");
const surge_1 = require("./surge");
const readVersion = () => {
    try {
        const packageJsonPath = (0, node_path_1.resolve)(__dirname, '../package.json');
        const packageJsonContent = (0, node_fs_1.readFileSync)(packageJsonPath, 'utf8');
        const parsed = JSON.parse(packageJsonContent);
        return typeof parsed.version === 'string' ? parsed.version : 'unknown';
    }
    catch {
        return 'unknown';
    }
};
const VERSION = readVersion();
const HELP_TEXT = `surge-vless-bridge v${VERSION}

Commands:
  init       Create a local config template
  sync       Fetch subscription(s), route vless via sing-box + anytls as native Surge, update profile
  rebuild    Rebuild Surge proxies from local sing-box configs + anytls sidecar only
  restore    Restore the latest backup or a specified backup file
  doctor     Validate detected paths and Surge sections
  version    Show current version
  help       Show this help

Flags:
  --config <path>             Path to the JSON config file
  --subscription-url <url>    Override subscription URL (comma-separate to merge several)
  --surge-config <path>       Override Surge profile path
  --sing-box-bin <path>       Override sing-box executable path
  --output-dir <path>         Override generated sing-box config directory
  --backup-dir <path>         Override Surge backup directory
  --group-name <name>         Override Surge policy group name
  --port-start <number>       Override the first local SOCKS port
  --version, -v               Show current version
  --force                     Overwrite config on init

Default config path:
  Global install              ~/.config/surge-vless-bridge/config.json
  Local development           ./.surge-vless-bridge.json

Examples:
  surge-vless-bridge init
  surge-vless-bridge sync --subscription-url https://example.com/sub
  surge-vless-bridge rebuild
  surge-vless-bridge doctor
  surge-vless-bridge version
`;
const parseArgs = (argv) => {
    const [command = 'help', ...rest] = argv;
    const options = {};
    const positionals = [];
    for (let index = 0; index < rest.length; index += 1) {
        const token = rest[index];
        if (!token) {
            continue;
        }
        if (!token.startsWith('--')) {
            positionals.push(token);
            continue;
        }
        const key = token.slice(2);
        const next = rest[index + 1];
        if (!next || next.startsWith('--')) {
            options[key] = true;
            continue;
        }
        options[key] = next;
        index += 1;
    }
    return { command, options, positionals };
};
const toOverrides = (options) => {
    const portStart = typeof options['port-start'] === 'string' ? Number(options['port-start']) : undefined;
    return {
        subscriptionUrl: typeof options['subscription-url'] === 'string' ? options['subscription-url'] : undefined,
        surgeConfigPath: typeof options['surge-config'] === 'string' ? options['surge-config'] : undefined,
        singBoxBinary: typeof options['sing-box-bin'] === 'string' ? options['sing-box-bin'] : undefined,
        outputDir: typeof options['output-dir'] === 'string' ? options['output-dir'] : undefined,
        backupDir: typeof options['backup-dir'] === 'string' ? options['backup-dir'] : undefined,
        policyGroupName: typeof options['group-name'] === 'string' ? options['group-name'] : undefined,
        portStart: Number.isFinite(portStart) ? portStart : undefined,
    };
};
const isUsingGlobalDefaultConfigPath = (configPath, hasExplicitConfigPath) => {
    if (hasExplicitConfigPath) {
        return false;
    }
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (!home) {
        return false;
    }
    return configPath === (0, node_path_1.resolve)(home, configuration_1.HOME_CONFIG_FILE_PATH);
};
const main = async () => {
    const parsed = parseArgs(process.argv.slice(2));
    const cwd = process.cwd();
    if (parsed.command === 'version' || parsed.command === '--version' || parsed.command === '-v') {
        console.log(VERSION);
        return;
    }
    if (parsed.command === 'help' || parsed.command === '--help' || parsed.command === '-h') {
        console.log(HELP_TEXT);
        return;
    }
    if (parsed.command === 'init') {
        const hasExplicitConfigPath = typeof parsed.options.config === 'string';
        const { configPath, warnings } = await (0, configuration_1.writeExampleConfig)({
            cwd,
            configPath: hasExplicitConfigPath ? parsed.options.config : undefined,
            force: Boolean(parsed.options.force),
        });
        console.log(`Created config template: ${configPath}`);
        if (isUsingGlobalDefaultConfigPath(configPath, hasExplicitConfigPath)) {
            console.log(`Global install detected. Your config file is at: ${configPath}`);
        }
        for (const warning of warnings) {
            console.warn(`Warning: ${warning}`);
        }
        console.log('Fill subscriptionUrl before running `sync`.');
        return;
    }
    const loaded = await (0, configuration_1.loadCliConfig)({
        cwd,
        configPath: typeof parsed.options.config === 'string' ? parsed.options.config : undefined,
        overrides: toOverrides(parsed.options),
    });
    if (!loaded.exists) {
        console.log(`Config file not found: ${loaded.configPath}`);
        console.log('Run `surge-vless-bridge init` first, or pass all required flags directly.');
    }
    switch (parsed.command) {
        case 'sync': {
            const result = await (0, surge_1.syncSubscriptionToSurge)(loaded.config);
            console.log(`Synced ${result.count} nodes (${result.vlessCount} vless via sing-box, ${result.anytlsCount} anytls native).`);
            if (result.skippedCount > 0) {
                console.log(`Skipped ${result.skippedCount} unsupported node(s).`);
            }
            console.log(`Backup saved to ${result.backupPath}`);
            break;
        }
        case 'rebuild': {
            const result = await (0, surge_1.rebuildSurgeFromLocalConfigs)(loaded.config);
            console.log(`Rebuilt ${result.count} nodes from local configs (${result.vlessCount} vless, ${result.anytlsCount} anytls).`);
            console.log(`Backup saved to ${result.backupPath}`);
            break;
        }
        case 'restore': {
            const restored = await (0, surge_1.restoreSurgeProfileBackup)({
                config: loaded.config,
                backupPath: parsed.positionals[0],
            });
            console.log(`Restored Surge profile from ${restored}`);
            break;
        }
        case 'doctor': {
            await (0, surge_1.runDoctor)(loaded.config);
            break;
        }
        default:
            console.log(HELP_TEXT);
            process.exitCode = 1;
    }
};
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map