import {
  defaultConfigPath,
  defaultSshConfigPath,
  knownAliases,
  loadHelperConfig,
  loadSshConfig,
  type HelperConfig,
} from './ssh/config.ts';
import { buildProfile, type RemoteProfile, type SshConfigHost } from './ssh/profile.ts';

export interface HostCatalog {
  config: HelperConfig;
  sshHosts: SshConfigHost[];
  aliases: string[];
}

/**
 * Loads both configuration sources once per call.
 *
 * Caching would be a correctness risk here: a user edits the config file in the
 * middle of a session, and a stale cache would keep pointing tools at the
 * previous host.
 */
export async function loadHostCatalog(env: NodeJS.ProcessEnv = process.env): Promise<HostCatalog> {
  const config = await loadHelperConfig(defaultConfigPath(env));
  const sshHosts = await loadSshConfig(defaultSshConfigPath(env));
  return { config, sshHosts, aliases: knownAliases(config, sshHosts) };
}

/**
 * Resolves an alias to a validated profile.
 *
 * Omitting the alias falls back to `defaultHost`, and refusing to guess when
 * there is no default keeps a tool from silently probing an unrelated machine.
 */
export function profileFor(catalog: HostCatalog, alias?: string): RemoteProfile {
  const resolved = alias ?? catalog.config.defaultHost;
  if (resolved === undefined) {
    const known = catalog.aliases.length > 0 ? catalog.aliases.join(', ') : 'none configured';
    throw new Error(
      `no host given and no defaultHost is set (known hosts: ${known}). Configure ~/.pi/agent/ssh-helper.json or pass a host alias.`,
    );
  }
  return buildProfile(resolved, catalog.config.hosts[resolved], catalog.sshHosts);
}
