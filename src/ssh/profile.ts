/**
 * Host resolution without ssh_config surprises.
 *
 * OpenSSH resolves a host by walking every `Host` block in order and taking the
 * first value it finds for each keyword, so a later block only fills the gaps.
 * Copying that rule matters: `Host *` blocks commonly carry `User` and
 * `IdentityFile`, and ignoring them would make a working alias fail here.
 *
 * `Match` blocks, `Include`, `ProxyCommand`, and negated patterns are not
 * modelled. A profile that depends on them must be spelled out in the helper's
 * own config file instead.
 */

export interface SshConfigHost {
  patterns: string[];
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
}

/** Values a user writes in `~/.ssh/config` or in this helper's config file. */
export interface HostOverrides {
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
  /** The same project's path on the remote host. */
  remoteWorkspace?: string;
  /** Local directory that `remoteWorkspace` corresponds to; defaults to pi's cwd. */
  localWorkspace?: string;
  /** Shell lines to source before every command, e.g. a ROS setup file. */
  prelude?: string[];
  /** Allows `mutating`/`irreversible` commands. Defaults to false. */
  allowMutating?: boolean;
  connectTimeoutSeconds?: number;
}

export interface RemoteProfile {
  alias: string;
  hostname: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
  remoteWorkspace: string;
  localWorkspace?: string;
  prelude: string[];
  allowMutating: boolean;
  connectTimeoutSeconds: number;
}

const MAX_PORT = 65_535;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;

/** Parses the subset of `ssh_config` this helper understands. */
export function parseSshConfig(text: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = [];
  let current: SshConfigHost | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line === '') continue;
    const match = /^([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!match) continue;
    const keyword = match[1].toLowerCase();
    const value = match[2].trim();
    if (value === '') continue;

    if (keyword === 'host') {
      current = { patterns: value.split(/\s+/).filter((pattern) => !pattern.startsWith('!')) };
      hosts.push(current);
      continue;
    }
    if (!current) continue;

    switch (keyword) {
      case 'hostname':
        current.hostname ??= value;
        break;
      case 'user':
        current.user ??= value;
        break;
      case 'port': {
        if (current.port !== undefined) break;
        const port = Number.parseInt(value, 10);
        if (Number.isInteger(port)) current.port = port;
        break;
      }
      case 'identityfile':
        current.identityFile ??= value;
        break;
      case 'proxyjump':
        current.proxyJump ??= value;
        break;
      default:
        break;
    }
  }
  return hosts;
}

/** Finds the host whose blocks supply values for `alias`, in ssh's own order. */
export function findSshHost(
  alias: string,
  hosts: readonly SshConfigHost[],
): SshConfigHost | undefined {
  const resolved: SshConfigHost = { patterns: [alias] };
  let matched = false;
  for (const host of hosts) {
    if (!host.patterns.some((pattern) => matchesHostPattern(pattern, alias))) continue;
    matched = true;
    resolved.hostname ??= host.hostname;
    resolved.user ??= host.user;
    resolved.port ??= host.port;
    resolved.identityFile ??= host.identityFile;
    resolved.proxyJump ??= host.proxyJump;
  }
  return matched ? resolved : undefined;
}

/**
 * Builds the profile every tool uses, validating it once.
 *
 * Configuration mistakes are rejected here rather than becoming an `ssh`
 * usage error later, and a host name that starts with `-` is refused because it
 * would be read as an option instead of a destination.
 */
export function buildProfile(
  alias: string,
  overrides: HostOverrides | undefined,
  sshHosts: readonly SshConfigHost[],
): RemoteProfile {
  assertAlias(alias, 'host alias');
  const fromSshConfig = findSshHost(alias, sshHosts);
  const hostname = overrides?.hostname ?? fromSshConfig?.hostname ?? alias;
  assertHostname(hostname);

  const user = overrides?.user ?? fromSshConfig?.user;
  if (user !== undefined) assertUser(user);

  const port = overrides?.port ?? fromSshConfig?.port;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > MAX_PORT)) {
    throw new Error(`host ${alias}: port must be an integer between 1 and ${MAX_PORT}`);
  }

  const remoteWorkspace = overrides?.remoteWorkspace;
  if (remoteWorkspace === undefined) {
    throw new Error(
      `host ${alias}: remoteWorkspace is required, because the helper refuses to guess where the project lives on the remote host`,
    );
  }
  if (!remoteWorkspace.startsWith('/')) {
    throw new Error(`host ${alias}: remoteWorkspace must be an absolute path`);
  }
  if (overrides?.localWorkspace !== undefined && !overrides.localWorkspace.startsWith('/')) {
    throw new Error(`host ${alias}: localWorkspace must be an absolute path`);
  }

  const prelude = overrides?.prelude ?? [];
  if (
    !Array.isArray(prelude) ||
    prelude.some((line) => typeof line !== 'string' || line.trim() === '')
  ) {
    throw new Error(`host ${alias}: prelude must be a list of non-empty shell lines`);
  }

  const connectTimeoutSeconds = overrides?.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS;
  if (!Number.isInteger(connectTimeoutSeconds) || connectTimeoutSeconds < 1) {
    throw new Error(`host ${alias}: connectTimeoutSeconds must be a positive integer`);
  }

  return {
    alias,
    hostname,
    user,
    port,
    identityFile: overrides?.identityFile ?? fromSshConfig?.identityFile,
    proxyJump: overrides?.proxyJump ?? fromSshConfig?.proxyJump,
    remoteWorkspace,
    localWorkspace: overrides?.localWorkspace,
    prelude: [...prelude],
    allowMutating: overrides?.allowMutating ?? false,
    connectTimeoutSeconds,
  };
}

/** `user@host` for ssh, or the bare host when no user is configured. */
export function sshDestination(profile: RemoteProfile): string {
  return profile.user === undefined ? profile.hostname : `${profile.user}@${profile.hostname}`;
}

export function assertAlias(alias: string, label: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(alias)) {
    throw new Error(`${label} must match [A-Za-z0-9._-]+ (got ${JSON.stringify(alias)})`);
  }
}

function assertHostname(hostname: string): void {
  if (!/^[A-Za-z0-9._:-]+$/.test(hostname)) {
    throw new Error(`invalid hostname ${JSON.stringify(hostname)}`);
  }
}

function assertUser(user: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(user)) {
    throw new Error(`invalid user ${JSON.stringify(user)}`);
  }
}

function matchesHostPattern(pattern: string, alias: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`, 'i');
  return regex.test(alias);
}

function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return hash === -1 ? line : line.slice(0, hash);
}
