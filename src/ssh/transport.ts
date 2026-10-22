import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  runLocalCommand,
  type CommandSpec,
  type CommandTransport,
  type RunResult,
} from 'pi-helper-core';
import {
  buildInspectionScript,
  buildProbeScript,
  parseCapabilities,
  parseInspection,
  type CapabilityReport,
  type Capabilities,
} from './capability.ts';
import { buildRemoteCommand, buildRemoteScript, wrapContainer } from './command.ts';
import type { ContainerContext } from './command.ts';
import { defaultControlDirPath } from './config.ts';
import { toRemotePath } from './map.ts';
import { shQuote } from './quote.ts';
import type { RemoteProfile } from './profile.ts';
import { sshDestination } from './profile.ts';

/** What the transport needs: the target profile and the local root it maps. */
export interface SshTransportOptions {
  profile: RemoteProfile;
  /** Local directory that `profile.remoteWorkspace` corresponds to. */
  localRoot: string;
  /** Directory holding the ControlMaster socket; defaults to `~/.pi/agent/ssh-helper-control`. */
  controlDir?: string;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL_PERSIST_SECONDS = 600;

/** The container a profile runs in, or `undefined` when it runs on the host. */
export function containerOf(profile: RemoteProfile): ContainerContext | undefined {
  if (profile.container === undefined) return undefined;
  // Validated when the profile was built; the default is unreachable.
  return { name: profile.container, workdir: profile.containerWorkdir ?? '/' };
}

/**
 * The path a local directory maps to.
 *
 * With a container the toolchain lives at the mount point, so helper tools must
 * be pointed there rather than at the host checkout.
 */
export function remoteRootOf(profile: RemoteProfile): string {
  return profile.containerWorkdir ?? profile.remoteWorkspace;
}

export function buildSshArgs(
  profile: RemoteProfile,
  command: string,
  controlDir: string,
): string[] {
  const args = [
    // Never prompt: a password or host-key question would hang a tool call
    // instead of failing with a message the model can act on.
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${profile.connectTimeoutSeconds}`,
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${join(controlDir, '%C')}`,
    '-o',
    `ControlPersist=${CONTROL_PERSIST_SECONDS}`,
  ];
  if (profile.port !== undefined) args.push('-p', String(profile.port));
  if (profile.identityFile !== undefined) args.push('-i', profile.identityFile);
  if (profile.proxyJump !== undefined) args.push('-J', profile.proxyJump);
  args.push(sshDestination(profile), command);
  return args;
}

/**
 * The transport `pi-helper-core` routes every helper command through.
 *
 * Two details carry the design:
 *
 * - `ControlMaster` keeps one connection alive, so a helper that runs thirty
 *   commands pays for one handshake instead of thirty.
 * - The client process is spawned with the core's *local* runner. `runCommand`
 *   would consult this same transport and recurse into itself.
 */
export function createSshTransport(options: SshTransportOptions): CommandTransport {
  const { profile, localRoot } = options;
  const controlDir = options.controlDir ?? defaultControlDirPath();
  let prepared: Promise<void> | undefined;

  const ensureControlDir = (): Promise<void> => {
    prepared ??= mkdir(controlDir, { recursive: true, mode: 0o700 }).then(() => undefined);
    return prepared;
  };

  return {
    id: `ssh:${profile.alias}`,
    mapCwd: (cwd) => toRemotePath(cwd, { localRoot, remoteRoot: remoteRootOf(profile) }),
    async exec(spec: CommandSpec): Promise<RunResult> {
      const container = containerOf(profile);
      const command = container
        ? wrapContainer(
            buildRemoteScript({
              // `docker exec -w` sets the directory, so no inner `cd` is needed.
              cwd: '',
              prelude: profile.prelude,
              env: forwardableEnv(spec.env),
              executable: spec.executable,
              args: spec.args,
            }),
            spec.cwd,
            container,
          )
        : buildRemoteCommand({
            cwd: spec.cwd,
            prelude: profile.prelude,
            env: forwardableEnv(spec.env),
            executable: spec.executable,
            args: spec.args,
          });
      await ensureControlDir();
      return runLocalCommand('ssh', buildSshArgs(profile, command, controlDir), {
        // The ssh client itself needs a local directory; it has nothing to do
        // with the remote cwd the command runs in.
        cwd: homedir(),
        stdin: spec.stdin,
        timeoutMs: spec.timeoutMs,
        maxBytes: spec.maxBytes,
        signal: spec.signal,
      });
    },
  };
}

export interface ProbeOutcome {
  result: RunResult;
  capabilities: Capabilities;
}

export interface InspectionOutcome extends ProbeOutcome {
  report: CapabilityReport;
}

/**
 * The probe runs through the same prelude as every command.
 *
 * Without this, a host whose ROS environment only exists in a setup file would
 * be reported as "ros2 missing" by the probe while `ros2` works for every real
 * command — the probe would be measuring a different shell than the one used.
 */
export function remoteProbeCommand(profile: RemoteProfile, script: string): string {
  const prelude = profile.prelude.map((line) => line.trim()).filter((line) => line !== '');
  const body = prelude.length === 0 ? script : [...prelude, script].join(' && ');
  const container = containerOf(profile);
  if (container !== undefined) {
    // The probe has to measure the same environment the commands will run in.
    return wrapContainer(body, container.workdir, container);
  }
  return prelude.length === 0 ? script : `bash -lc ${shQuote(body)}`;
}

/** Cheap reachability + capability probe, safe to call before deciding anything. */
export async function probeHost(
  profile: RemoteProfile,
  options: { controlDir?: string; timeoutMs?: number } = {},
): Promise<ProbeOutcome> {
  const controlDir = options.controlDir ?? defaultControlDirPath();
  await mkdir(controlDir, { recursive: true, mode: 0o700 });
  const result = await runLocalCommand(
    'ssh',
    buildSshArgs(profile, remoteProbeCommand(profile, buildProbeScript()), controlDir),
    { cwd: homedir(), timeoutMs: options.timeoutMs ?? 20_000, maxBytes: 64 * 1024 },
  );
  return { result, capabilities: parseCapabilities(result.stdout) };
}

/** Probe plus versions and installed ROS distributions. */
export async function inspectHost(
  profile: RemoteProfile,
  options: { controlDir?: string; timeoutMs?: number } = {},
): Promise<InspectionOutcome> {
  const controlDir = options.controlDir ?? defaultControlDirPath();
  await mkdir(controlDir, { recursive: true, mode: 0o700 });
  const result = await runLocalCommand(
    'ssh',
    buildSshArgs(profile, remoteProbeCommand(profile, buildInspectionScript()), controlDir),
    { cwd: homedir(), timeoutMs: options.timeoutMs ?? 30_000, maxBytes: 128 * 1024 },
  );
  return {
    result,
    capabilities: parseCapabilities(result.stdout),
    report: parseInspection(result.stdout),
  };
}

/**
 * Only the caller's own overlay is forwarded, never this machine's environment.
 *
 * Shipping the local environment to a robot would import this machine's
 * `ROS_DOMAIN_ID`, proxy settings, and `PATH` — the last of which would hide
 * the remote toolchain behind local binaries of the same name.
 */
function forwardableEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  if (env === undefined) return {};
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && ENV_NAME.test(name)) forwarded[name] = value;
  }
  return forwarded;
}
