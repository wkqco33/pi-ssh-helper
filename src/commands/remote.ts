import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { loadHostCatalog, profileFor, type HostCatalog } from '../hosts.ts';
import type { RemoteProfile } from '../ssh/profile.ts';
import { probeHost } from '../ssh/transport.ts';
import { activeRemote, activateRemote, deactivateRemote } from '../session.ts';

const STATUS_KEY = 'ssh-remote';
const USAGE = 'usage: /ssh-remote on <host> [localWorkspace] | off | status | hosts';

export function registerRemoteCommand(pi: ExtensionAPI): void {
  pi.registerCommand('ssh-remote', {
    description:
      'Route pi helper tools (ros_*, py_*, rust_*) to a remote host over SSH, or report the current target',
    handler: async (args, ctx) => {
      const [subcommand = 'status', ...rest] = args.trim().split(/\s+/).filter(Boolean);
      switch (subcommand) {
        case 'on':
          await turnOn(rest, ctx);
          return;
        case 'off':
          turnOff(ctx);
          return;
        case 'status':
          showStatus(ctx);
          return;
        case 'hosts':
          await listHosts(ctx);
          return;
        default:
          ctx.ui.notify(USAGE, 'warning');
      }
    },
  });

  // The transport is process-wide, so it must not outlive the session that
  // activated it: the next session in this process would silently be remote.
  pi.on('session_shutdown', () => {
    deactivateRemote();
  });
}

async function turnOn(rest: string[], ctx: ExtensionCommandContext): Promise<void> {
  const alias = rest[0];
  if (alias === undefined) {
    ctx.ui.notify(USAGE, 'warning');
    return;
  }

  let profile: RemoteProfile;
  try {
    profile = profileFor(await loadHostCatalog(), alias);
  } catch (error) {
    ctx.ui.notify(`SSH: ${(error as Error).message}`, 'error');
    return;
  }

  // Probe before installing the transport: activating first would redirect every
  // helper tool to a host that was never reachable.
  const probe = await probeHost(profile);
  if (probe.result.code !== 0) {
    const detail = probe.result.timedOut
      ? 'timed out'
      : (probe.result.stderr.trim().split(/\r?\n/).at(-1) ??
        `exit code ${String(probe.result.code)}`);
    ctx.ui.notify(`SSH: ${alias} is not reachable — ${detail}`, 'error');
    return;
  }

  const localRoot = rest[1] ?? profile.localWorkspace ?? ctx.cwd;
  let active: ReturnType<typeof activateRemote>;
  try {
    active = activateRemote(profile, localRoot);
  } catch (error) {
    ctx.ui.notify(`SSH: ${(error as Error).message}`, 'error');
    return;
  }

  ctx.ui.setStatus(STATUS_KEY, `SSH: ${profile.alias} (ros-tools=remote)`);
  ctx.ui.notify(
    `SSH: ${profile.alias} active — ${active.localRoot} → ${profile.remoteWorkspace}; helper tools now run remotely`,
    'info',
  );
  if (profile.prelude.length === 0) {
    ctx.ui.notify(
      `SSH: no prelude configured for ${profile.alias}; add a setup file to "prelude" if ros2 is not on the login PATH`,
      'warning',
    );
  }
}

function turnOff(ctx: ExtensionCommandContext): void {
  const previous = deactivateRemote();
  ctx.ui.setStatus(STATUS_KEY, undefined);
  ctx.ui.notify(
    previous === null
      ? 'SSH: already inactive — helper tools run locally'
      : `SSH: ${previous.alias} deactivated — helper tools run locally again`,
    'info',
  );
}

function showStatus(ctx: ExtensionCommandContext): void {
  const active = activeRemote();
  if (active === null) {
    ctx.ui.notify('SSH: inactive — helper tools run locally', 'info');
    return;
  }
  const minutes = Math.max(0, Math.round((Date.now() - active.activatedAt) / 60_000));
  ctx.ui.notify(
    `SSH: ${active.profile.alias} (${active.profile.hostname}) active for ${minutes}m — ${active.localRoot} → ${active.profile.remoteWorkspace}, ros-tools=remote`,
    'info',
  );
}

async function listHosts(ctx: ExtensionCommandContext): Promise<void> {
  let catalog: HostCatalog;
  try {
    catalog = await loadHostCatalog();
  } catch (error) {
    ctx.ui.notify(`SSH: ${(error as Error).message}`, 'error');
    return;
  }
  const aliases = catalog.aliases;
  if (aliases.length === 0) {
    ctx.ui.notify(
      'SSH: no hosts found — add entries to ~/.pi/agent/ssh-helper.json or ~/.ssh/config',
      'warning',
    );
    return;
  }
  const lines = aliases.map((alias) => {
    const overrides = catalog.config.hosts[alias];
    const target =
      overrides?.remoteWorkspace === undefined ? '(no remoteWorkspace)' : overrides.remoteWorkspace;
    return `${alias} → ${target}`;
  });
  ctx.ui.notify(`SSH hosts:\n${lines.join('\n')}`, 'info');
}
