import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  runLocalCommand,
  type CommandSpec,
  type CommandTransport,
  type RunOptions,
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
const MAX_TIMER_MS = 2_147_483_647;

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

/** Connection options shared by every ssh invocation, master included. */
function connectionArgs(
  profile: RemoteProfile,
  controlDir: string,
  startMaster: boolean,
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
    `ControlMaster=${startMaster ? 'auto' : 'no'}`,
    '-o',
    `ControlPath=${join(controlDir, '%C')}`,
    '-o',
    `ControlPersist=${startMaster ? CONTROL_PERSIST_SECONDS : 'no'}`,
  ];
  if (profile.port !== undefined) args.push('-p', String(profile.port));
  if (profile.identityFile !== undefined) args.push('-i', profile.identityFile);
  if (profile.proxyJump !== undefined) args.push('-J', profile.proxyJump);
  return args;
}

export function buildSshArgs(
  profile: RemoteProfile,
  command: string,
  controlDir: string,
): string[] {
  // ControlMaster=no still reuses an existing socket. Only the warm-up may
  // create a master, otherwise the daemon would inherit this command's pipes.
  return [...connectionArgs(profile, controlDir, false), sshDestination(profile), command];
}

/**
 * The ssh invocation that owns the multiplexed connection.
 *
 * `-N` opens no session and `-f` backgrounds the process after authentication,
 * so the foreground ssh exits as soon as the master is usable. `ControlMaster`
 * stays `auto`: when a master already exists this is just another mux client and
 * returns immediately, which avoids the "ControlSocket already exists" path that
 * would otherwise leave a stray direct connection behind.
 */
export function buildMasterArgs(profile: RemoteProfile, controlDir: string): string[] {
  return [...connectionArgs(profile, controlDir, true), '-N', '-f', sshDestination(profile)];
}

/** Longest a master warm-up may take before the real command runs anyway. */
const MASTER_BOOTSTRAP_TIMEOUT_MS = 15_000;

interface MasterPreparation {
  controller: AbortController;
  job: Promise<boolean>;
  waiters: number;
  expiresAt?: number;
}

const warmMasters = new Map<string, MasterPreparation>();

function masterKey(profile: RemoteProfile, controlDir: string): string {
  return [
    controlDir,
    profile.hostname,
    profile.user ?? '',
    String(profile.port ?? 22),
    profile.identityFile ?? '',
    profile.proxyJump ?? '',
  ].join('\u0000');
}

/**
 * Starts the persistent master with this process's stdio *ignored*.
 *
 * This is the whole point of separating the warm-up from the commands: the
 * daemonized master inherits the stdin/stdout/stderr of the ssh process that
 * created it. When a tool call created the master, the master kept a copy of the
 * tool's stderr until the remote command finished — so a completed ssh call
 * still looked hung. With `stdio: 'ignore'` the master only ever holds `/dev/null`.
 */
function bootstrapMaster(
  profile: RemoteProfile,
  controlDir: string,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn('ssh', buildMasterArgs(profile, controlDir), {
        cwd: homedir(),
        stdio: 'ignore',
        signal,
        killSignal: 'SIGKILL',
      });
      child.once('error', () => resolve(false));
      child.once('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/** Stop waiting on local preparation without dropping its rejection handler. */
function waitForPreparation(job: Promise<unknown>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = (): void => resolve();
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    job.then(
      () => {
        signal.removeEventListener('abort', stop);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(error);
      },
    );
  });
}

/** Share one warm-up while keeping each caller's cancellation independent. */
export async function ensureControlMaster(
  profile: RemoteProfile,
  controlDir: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  const key = masterKey(profile, controlDir);
  const now = performance.now();
  for (const [candidate, master] of warmMasters) {
    if (master.expiresAt !== undefined && master.expiresAt <= now) warmMasters.delete(candidate);
  }

  let master = warmMasters.get(key);
  if (master?.expiresAt !== undefined) return;
  if (!master) {
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(MASTER_BOOTSTRAP_TIMEOUT_MS);
    const job = bootstrapMaster(profile, controlDir, AbortSignal.any([controller.signal, timeout]));
    const preparation: MasterPreparation = { controller, job, waiters: 0 };
    warmMasters.set(key, preparation);
    void job.then((ready) => {
      if (warmMasters.get(key) !== preparation) return;
      if (ready) preparation.expiresAt = performance.now() + CONTROL_PERSIST_SECONDS * 1_000;
      else warmMasters.delete(key);
    });
    master = preparation;
  }

  master.waiters += 1;
  try {
    if (signal) await waitForPreparation(master.job, signal);
    else await master.job;
  } finally {
    master.waiters -= 1;
    if (master.waiters === 0 && master.expiresAt === undefined && warmMasters.get(key) === master) {
      warmMasters.delete(key);
      master.controller.abort();
    }
  }
}

/** Spend one monotonic time budget on preparation and the SSH command. */
export async function runSshCommand(
  profile: RemoteProfile,
  controlDir: string,
  command: string,
  options: Omit<RunOptions, 'cwd' | 'env'>,
): Promise<RunResult> {
  const startedAt = performance.now();
  const timeoutMs = options.timeoutMs
    ? Math.max(0, Math.min(Math.ceil(options.timeoutMs), MAX_TIMER_MS))
    : undefined;
  const deadline = timeoutMs === undefined ? Infinity : startedAt + timeoutMs;
  const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  const prepSignal =
    options.signal && timeout
      ? AbortSignal.any([options.signal, timeout])
      : (options.signal ?? timeout);
  const elapsed = (): number => Math.round(performance.now() - startedAt);

  if (!prepSignal?.aborted && timeoutMs !== 0) {
    const directory = mkdir(controlDir, { recursive: true, mode: 0o700 });
    if (prepSignal) await waitForPreparation(directory, prepSignal);
    else await directory;
    await ensureControlMaster(profile, controlDir, prepSignal);
  }
  const remaining = deadline - performance.now();
  if (prepSignal?.aborted || remaining <= 0) {
    const cancelled = options.signal?.aborted === true;
    return {
      code: null,
      stdout: '',
      stderr: '',
      timedOut: !cancelled,
      cancelled,
      truncated: false,
      durationMs: elapsed(),
    };
  }

  const key = masterKey(profile, controlDir);
  const master = warmMasters.get(key);
  const result = await runLocalCommand('ssh', buildSshArgs(profile, command, controlDir), {
    ...options,
    cwd: homedir(),
    timeoutMs: Number.isFinite(remaining) ? Math.ceil(remaining) : undefined,
  });
  if (result.code === 255 && warmMasters.get(key) === master) warmMasters.delete(key);
  return { ...result, durationMs: elapsed() };
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
            spec.stdin !== undefined,
          )
        : buildRemoteCommand({
            cwd: spec.cwd,
            prelude: profile.prelude,
            env: forwardableEnv(spec.env),
            executable: spec.executable,
            args: spec.args,
          });
      return runSshCommand(profile, controlDir, command, {
        stdin: spec.stdin,
        timeoutMs: spec.timeoutMs ?? 120_000,
        maxBytes: spec.maxBytes,
        signal: spec.signal,
        terminationGraceMs: spec.terminationGraceMs,
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
  options: { controlDir?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProbeOutcome> {
  const controlDir = options.controlDir ?? defaultControlDirPath();
  const result = await runSshCommand(
    profile,
    controlDir,
    remoteProbeCommand(profile, buildProbeScript()),
    {
      timeoutMs: options.timeoutMs ?? 20_000,
      maxBytes: 64 * 1024,
      signal: options.signal,
    },
  );
  return { result, capabilities: parseCapabilities(result.stdout) };
}

/** Probe plus versions and installed ROS distributions. */
export async function inspectHost(
  profile: RemoteProfile,
  options: { controlDir?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<InspectionOutcome> {
  const controlDir = options.controlDir ?? defaultControlDirPath();
  const result = await runSshCommand(
    profile,
    controlDir,
    remoteProbeCommand(profile, buildInspectionScript()),
    {
      timeoutMs: options.timeoutMs ?? 30_000,
      maxBytes: 128 * 1024,
      signal: options.signal,
    },
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
