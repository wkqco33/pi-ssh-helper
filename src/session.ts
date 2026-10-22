import { setTransport, type CommandTransport } from 'pi-helper-core';
import type { RemoteProfile } from './ssh/profile.ts';
import { createSshTransport } from './ssh/transport.ts';

/**
 * The one session-wide activation state.
 *
 * Routing is deliberately a user action (`/ssh-remote on <host>`) rather than a
 * tool call: a model that can silently redirect every `ros_*`/`py_*`/`rust_*`
 * tool to another machine has no way to notice it aimed at the wrong one.
 */
export interface ActiveRemote {
  profile: RemoteProfile;
  transport: CommandTransport;
  localRoot: string;
  activatedAt: number;
}

let active: ActiveRemote | null = null;

export function activateRemote(profile: RemoteProfile, localRoot: string): ActiveRemote {
  if (!localRoot.startsWith('/')) {
    throw new Error(`local workspace must be an absolute path (got ${JSON.stringify(localRoot)})`);
  }
  const transport = createSshTransport({ profile, localRoot });
  setTransport(transport);
  active = { profile, transport, localRoot, activatedAt: Date.now() };
  return active;
}

/** Restores local execution; safe to call when nothing is active. */
export function deactivateRemote(): RemoteProfile | null {
  const previous = active;
  setTransport(null);
  active = null;
  return previous?.profile ?? null;
}

export function activeRemote(): ActiveRemote | null {
  return active;
}
