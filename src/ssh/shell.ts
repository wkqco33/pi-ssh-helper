import { runLocalCommand, type RunResult } from 'pi-helper-core';
import { homedir } from 'node:os';
import { shQuote } from './quote.ts';
import { wrapContainer, type ContainerContext } from './command.ts';
import { buildSshArgs } from './transport.ts';
import type { RemoteProfile } from './profile.ts';

/**
 * Runs a shell command the way a user would type it on the remote host.
 *
 * The command itself is *not* quoted: it is a shell expression by definition,
 * the same trust level as pi's own bash tool, and the caller gates it by risk
 * class before this runs. Only the working directory and prelude are quoted.
 */
export interface RemoteShellInput {
  command: string;
  /** Remote absolute directory; omitted means the login shell's default. */
  cwd?: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  controlDir?: string;
  /** When set, the command runs inside this container instead of on the host. */
  container?: ContainerContext;
}

export async function runRemoteShell(
  profile: RemoteProfile,
  controlDir: string,
  input: RemoteShellInput,
): Promise<RunResult> {
  if (input.cwd !== undefined && input.cwd !== '' && !input.cwd.startsWith('/')) {
    throw new Error(`remote cwd must be an absolute path: ${input.cwd}`);
  }

  const prelude = profile.prelude.map((line) => line.trim()).filter((line) => line !== '');
  let remoteCommand: string;
  if (input.container !== undefined) {
    // The prelude belongs to the container too: on a robot the host has no ROS.
    const body = [...prelude, input.command].join(' && ');
    remoteCommand = wrapContainer(body, input.cwd ?? input.container.workdir, input.container);
  } else {
    const steps = input.cwd === undefined || input.cwd === '' ? [] : [`cd ${shQuote(input.cwd)}`];
    steps.push(...prelude, input.command);
    remoteCommand = `bash -lc ${shQuote(steps.join(' && '))}`;
  }

  return runLocalCommand('ssh', buildSshArgs(profile, remoteCommand, controlDir), {
    cwd: homedir(),
    timeoutMs: input.timeoutMs ?? 120_000,
    maxBytes: input.maxBytes ?? 100 * 1024,
    signal: input.signal,
  });
}
