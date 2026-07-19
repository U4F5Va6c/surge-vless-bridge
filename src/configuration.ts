import { readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import type { AddressResolverConfig, CliConfig, CliConfigInput } from './types/cli-config';
import { pathExists, readJsonFile, writeTextFile } from './utils/fs';

export const CONFIG_FILE_NAME = '.surge-vless-bridge.json';
export const HOME_CONFIG_FILE_PATH = join('.config', 'surge-vless-bridge', 'config.json');

// Request the subscription as a Clash / mihomo client. Panels serve their
// Clash YAML (which includes anytls and every other protocol) to this UA; a
// browser-like UA makes some panels return an HTML preview page instead, and a
// v2ray UA drops anytls nodes. The legacy base64 path still works for providers
// that ignore the UA.
const DEFAULT_HEADERS = {
  accept: '*/*',
  'user-agent': 'clash-verge/v1.7.0',
} as const;

const DEFAULT_ADDRESS_RESOLVER: AddressResolverConfig = {
  strategy: 'system',
  dohEndpoint: 'https://1.1.1.1/dns-query',
  dnsServers: ['1.1.1.1', '8.8.8.8'],
  filterSurgeFakeIp: true,
};

const detectSingBoxBinary = async () => {
  const result = spawnSync('which', ['sing-box'], {
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
    exists: await pathExists(fallbackPath),
  };
};

const detectSurgeConfigPath = async () => {
  const home = process.env.HOME;
  if (!home) {
    return '';
  }

  const profilesDir = join(home, 'Library/Application Support/Surge/Profiles');

  try {
    const entries = await readdir(profilesDir, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.conf'))
      .map((entry) => join(profilesDir, entry.name));

    if (candidates.length === 1) {
      return candidates[0] ?? '';
    }

    const sortedByMtime = await Promise.all(
      candidates.map(async (candidate) => ({
        path: candidate,
        mtimeMs: (await stat(candidate)).mtimeMs,
      })),
    );

    sortedByMtime.sort((left, right) => {
      if (right.mtimeMs !== left.mtimeMs) {
        return right.mtimeMs - left.mtimeMs;
      }

      return right.path.localeCompare(left.path);
    });

    return sortedByMtime[0]?.path ?? '';
  } catch {
    return '';
  }
};

export const getDefaultConfig = async (_cwd: string): Promise<CliConfig> => {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  const stateDir = join(home, '.config', 'surge-vless-bridge');
  const singBoxBinary = await detectSingBoxBinary();

  return {
    subscriptionUrl: '',
    surgeConfigPath: await detectSurgeConfigPath(),
    singBoxBinary: singBoxBinary.path,
    outputDir: join(stateDir, 'nodes'),
    backupDir: join(stateDir, 'backups'),
    policyGroupName: 'VLESS',
    proxyStartMarker: '# vless start',
    proxyEndMarker: '# vless end',
    portStart: 2081,
    subscriptionOutputPath: join(stateDir, 'vless_nodes.txt'),
    requestHeaders: { ...DEFAULT_HEADERS },
    addressResolver: { ...DEFAULT_ADDRESS_RESOLVER },
  };
};

const resolveGitRoot = (cwd: string): string | undefined => {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.status === 0) {
    return result.stdout.trim() || undefined;
  }

  return undefined;
};

const resolveDefaultConfigPath = (cwd: string) => {
  const gitRoot = resolveGitRoot(cwd);
  if (gitRoot) {
    return join(gitRoot, CONFIG_FILE_NAME);
  }

  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home) {
    return join(home, HOME_CONFIG_FILE_PATH);
  }

  return resolve(cwd, CONFIG_FILE_NAME);
};

const mergeConfig = (base: CliConfig, input?: CliConfigInput): CliConfig => {
  if (!input) {
    return base;
  }

  const definedEntries = Object.entries(input).filter(([, value]) => value !== undefined);
  const sanitizedInput = Object.fromEntries(definedEntries) as CliConfigInput;
  const addressResolverInput =
    typeof sanitizedInput.addressResolver === 'string'
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

export const loadCliConfig = async ({
  cwd,
  configPath,
  overrides,
}: {
  cwd: string;
  configPath?: string;
  overrides?: CliConfigInput;
}) => {
  const defaults = await getDefaultConfig(cwd);
  const resolvedConfigPath = configPath ? resolve(cwd, configPath) : resolveDefaultConfigPath(cwd);

  if (!(await pathExists(resolvedConfigPath))) {
    return {
      config: mergeConfig(defaults, overrides),
      configPath: resolvedConfigPath,
      exists: false,
    };
  }

  const parsed = await readJsonFile<CliConfigInput>(resolvedConfigPath);
  return {
    config: mergeConfig(mergeConfig(defaults, parsed), overrides),
    configPath: resolvedConfigPath,
    exists: true,
  };
};

export const writeExampleConfig = async ({
  cwd,
  configPath,
  force,
}: {
  cwd: string;
  configPath?: string;
  force?: boolean;
}) => {
  const defaults = await getDefaultConfig(cwd);
  const singBoxBinary = await detectSingBoxBinary();
  const resolvedConfigPath = configPath ? resolve(cwd, configPath) : resolveDefaultConfigPath(cwd);

  if (!force && (await pathExists(resolvedConfigPath))) {
    throw new Error(`Config file already exists: ${resolvedConfigPath}`);
  }

  const example: CliConfigInput = {
    // A single URL string, or an array to merge multiple subscriptions.
    subscriptionUrl: [''],
    surgeConfigPath: defaults.surgeConfigPath,
    policyGroupName: defaults.policyGroupName,
    portStart: defaults.portStart,
  };

  await writeTextFile(resolvedConfigPath, `${JSON.stringify(example, null, 2)}\n`);
  return {
    configPath: resolvedConfigPath,
    warnings: singBoxBinary.exists
      ? []
      : [
          `sing-box not found. Install it first(brew install sing-box), or update singBoxBinary manually: ${singBoxBinary.path}`,
        ],
  };
};
