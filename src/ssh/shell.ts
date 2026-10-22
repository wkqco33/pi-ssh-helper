import { runLocalCommand, type RunResult } from 'pi-helper-core';
import { homedir } from 'node:os';
import { shQuote } from './quote.ts';
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
}

export async function runRemoteShell(
  profile: RemoteProfile,
  controlDir: string,
  input: RemoteShellInput,
): Promise<RunResult> {
  const steps: string[] = [];
  if (input.cwd !== undefined && input.cwd !== '') {
    if (!input.cwd.startsWith('/'))
      throw new Error(`remote cwd must be an absolute path: ${input.cwd}`);
    steps.push(`cd ${shQuote(input.cwd)}`);
  }
  for (const line of profile.prelude) {
    const trimmed = line.trim();
    if (trimmed !== '') steps.push(trimmed);
  }
  steps.push(input.command);
  const script = steps.join(' && ');

  return runLocalCommand('ssh', buildSshArgs(profile, `bash -lc ${shQuote(script)}`, controlDir), {
    cwd: homedir(),
    timeoutMs: input.timeoutMs ?? 120_000,
    maxBytes: input.maxBytes ?? 100 * 1024,
    signal: input.signal,
  });
}
