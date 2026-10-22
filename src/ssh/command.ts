import { shJoin, shQuote } from './quote.ts';

/** One command as it will be assembled for the remote login shell. */
export interface RemoteCommandInput {
  /** Remote absolute working directory; empty means "leave it to the login shell". */
  cwd: string;
  /** Shell lines sourced before the command, e.g. a ROS setup file. */
  prelude?: readonly string[];
  /** Environment values to export, typically a helper's per-call overlay. */
  env?: Readonly<Record<string, string>>;
  executable: string;
  args: readonly string[];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The script the remote host runs, without the shell that launches it.
 *
 * Every caller-supplied value is quoted, so a path with a space or a `$(...)`
 * reaches the command as data. The `exec` matters: without it the shell stays
 * around as a parent, and killing the ssh client would leave the real command
 * running on the remote side.
 */
export function buildRemoteScript(input: RemoteCommandInput): string {
  const steps: string[] = [];
  if (input.cwd !== '') steps.push(`cd ${shQuote(input.cwd)}`);

  for (const [name, value] of Object.entries(input.env ?? {})) {
    if (!ENV_NAME.test(name)) {
      throw new Error(`refusing to export ${JSON.stringify(name)}: not a shell variable name`);
    }
    steps.push(`export ${name}=${shQuote(value)}`);
  }

  // Prelude lines are configuration, not user input: they are the only place a
  // raw shell fragment is allowed, and a blank one is dropped rather than
  // turning the chain into a syntax error.
  for (const line of input.prelude ?? []) {
    const trimmed = line.trim();
    if (trimmed !== '') steps.push(trimmed);
  }

  steps.push(`exec ${shJoin([input.executable, ...input.args])}`);
  return steps.join(' && ');
}

/**
 * The full remote command, quoted for one more shell.
 *
 * `ssh host 'bash -lc ...'` is interpreted by the remote user's login shell
 * first, so the script needs its own layer of quoting on top of the quoting
 * inside it.
 */
export function buildRemoteCommand(input: RemoteCommandInput): string {
  return `bash -lc ${shQuote(buildRemoteScript(input))}`;
}
