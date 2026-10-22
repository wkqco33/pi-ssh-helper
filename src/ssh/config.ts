import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HostOverrides, SshConfigHost } from './profile.ts';
import { assertAlias, parseSshConfig } from './profile.ts';

/**
 * Two configuration sources, on purpose:
 *
 * - `~/.ssh/config` already holds the connection facts a user maintains (alias,
 *   jump host, identity file). Re-asking for them would immediately drift.
 * - This helper's own file holds what ssh has no concept of: where the project
 *   lives on the other side, which shell prelude to source, and whether remote
 *   mutation is allowed.
 *
 * The helper file wins per field, so an alias can reuse an ssh_config entry and
 * override only `remoteWorkspace`.
 */

export const CONFIG_PATH_ENV = 'PI_SSH_HELPER_CONFIG';
export const CONTROL_DIR_ENV = 'PI_SSH_HELPER_CONTROL_DIR';

export interface HelperConfig {
  /** Hosts by alias. */
  hosts: Record<string, HostOverrides>;
  /** Host used when a command omits one. */
  defaultHost?: string;
}

const OVERRIDE_KEYS = new Set([
  'hostname',
  'user',
  'port',
  'identityFile',
  'proxyJump',
  'remoteWorkspace',
  'localWorkspace',
  'prelude',
  'allowMutating',
  'connectTimeoutSeconds',
  'container',
  'containerWorkdir',
]);

const TOP_LEVEL_KEYS = new Set(['hosts', 'defaultHost']);

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CONFIG_PATH_ENV];
  if (override !== undefined && override !== '') return override;
  return join(homedir(), '.pi', 'agent', 'ssh-helper.json');
}

export function defaultSshConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_SSH_CONFIG;
  if (override !== undefined && override !== '') return override;
  return join(homedir(), '.ssh', 'config');
}

export function defaultControlDirPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CONTROL_DIR_ENV];
  if (override !== undefined && override !== '') return override;
  return join(homedir(), '.pi', 'agent', 'ssh-helper-control');
}

/**
 * Rejects unknown keys instead of ignoring them.
 *
 * A typo (`remoteWorksapce`) that is silently dropped would surface much later
 * as "the tool ran in the wrong directory", which is exactly the failure this
 * helper exists to prevent.
 */
export function parseHelperConfig(text: string, source: string): HelperConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}: invalid JSON (${(error as Error).message})`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${source}: expected a JSON object`);
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new Error(`${source}: unknown key ${JSON.stringify(key)}`);
    }
  }

  const hostsRaw = record.hosts ?? {};
  if (typeof hostsRaw !== 'object' || hostsRaw === null || Array.isArray(hostsRaw)) {
    throw new Error(`${source}: "hosts" must be an object keyed by alias`);
  }

  const hosts: Record<string, HostOverrides> = {};
  for (const [alias, value] of Object.entries(hostsRaw as Record<string, unknown>)) {
    assertAlias(alias, `${source}: host alias`);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${source}: host ${alias} must be an object`);
    }
    const entry = value as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!OVERRIDE_KEYS.has(key)) {
        throw new Error(`${source}: host ${alias} has unknown key ${JSON.stringify(key)}`);
      }
    }
    hosts[alias] = validateOverrides(alias, entry, source);
  }

  const defaultHost = record.defaultHost;
  if (defaultHost !== undefined) {
    if (typeof defaultHost !== 'string')
      throw new Error(`${source}: "defaultHost" must be a string`);
    assertAlias(defaultHost, `${source}: defaultHost`);
    if (hosts[defaultHost] === undefined) {
      throw new Error(`${source}: defaultHost ${defaultHost} is not defined under "hosts"`);
    }
  }

  return defaultHost === undefined ? { hosts } : { hosts, defaultHost };
}

/**
 * Checks the value types the resolver relies on.
 *
 * `allowMutating: "yes"` would be truthy and silently enable remote mutation,
 * so a non-boolean is rejected here rather than trusted later.
 */
function validateOverrides(
  alias: string,
  entry: Record<string, unknown>,
  source: string,
): HostOverrides {
  const fail = (key: string, expected: string): never => {
    throw new Error(`${source}: host ${alias}.${key} must be ${expected}`);
  };
  const stringKeys = [
    'hostname',
    'user',
    'identityFile',
    'proxyJump',
    'remoteWorkspace',
    'localWorkspace',
    'container',
    'containerWorkdir',
  ] as const;
  for (const key of stringKeys) {
    const value = entry[key];
    if (value !== undefined && typeof value !== 'string') fail(key, 'a string');
  }
  for (const key of ['port', 'connectTimeoutSeconds'] as const) {
    const value = entry[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value))) {
      fail(key, 'an integer');
    }
  }
  const prelude = entry.prelude;
  if (
    prelude !== undefined &&
    (!Array.isArray(prelude) || prelude.some((line) => typeof line !== 'string'))
  ) {
    fail('prelude', 'a list of strings');
  }
  const allowMutating = entry.allowMutating;
  if (allowMutating !== undefined && typeof allowMutating !== 'boolean') {
    fail('allowMutating', 'a boolean');
  }
  return entry as HostOverrides;
}

/** Reads the helper config; a missing file is an empty config, not an error. */
export async function loadHelperConfig(path: string): Promise<HelperConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { hosts: {} };
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  return parseHelperConfig(text, path);
}

/** Reads `~/.ssh/config`; a missing file simply means no aliases. */
export async function loadSshConfig(path: string): Promise<SshConfigHost[]> {
  try {
    return parseSshConfig(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`${path}: ${(error as Error).message}`);
  }
}

/** Host aliases known to either source, sorted for a stable listing. */
export function knownAliases(config: HelperConfig, sshHosts: readonly SshConfigHost[]): string[] {
  const aliases = new Set(Object.keys(config.hosts));
  for (const host of sshHosts) {
    for (const pattern of host.patterns) {
      // A wildcard is not an alias a user can type; listing it would be noise.
      if (pattern.includes('*') || pattern.includes('?')) continue;
      aliases.add(pattern);
    }
  }
  return [...aliases].sort();
}
