import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getTransport, runLocalCommand, type CommandTransport } from 'pi-helper-core';

const CORE = 'pi-helper-core';
const PI = '@earendil-works/pi-coding-agent';
const PACKAGES = new Set([
  'pi-bot-connect',
  'pi-python-helper',
  'pi-ros-helper',
  'pi-rust-helper',
  'pi-ssh-helper',
  '@wkqco33/pi-loop-guard',
]);
const TOOLS = ['git', 'ssh', 'docker', 'python3', 'uv', 'ros2', 'colcon', 'cargo', 'rustc'];
const PROBE =
  'for tool in "$@"; do if command -v "$tool" >/dev/null 2>&1; then printf "PI_DOCTOR:%s\\n" "$tool"; fi; done';
const USAGE = 'usage: /helper-doctor [--help]';

interface Manifest {
  file: string;
  name: string;
  version: string;
}

async function findManifest(
  entry: string,
  names: ReadonlySet<string>,
): Promise<Manifest | undefined> {
  if (!isAbsolute(entry)) return undefined;
  let directory: string;
  try {
    directory = dirname(await realpath(entry));
  } catch {
    return undefined;
  }
  for (;;) {
    const file = join(directory, 'package.json');
    try {
      const value = JSON.parse(await readFile(file, 'utf8')) as Partial<Manifest> | null;
      if (
        typeof value?.name === 'string' &&
        typeof value.version === 'string' &&
        names.has(value.name)
      ) {
        return { file, name: value.name, version: value.version };
      }
    } catch {
      // Extension entry points can live several directories below the manifest.
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function coreVersion(anchor: string): Promise<string | undefined> {
  try {
    const entry = createRequire(anchor).resolve(CORE);
    return (await findManifest(entry, new Set([CORE])))?.version;
  } catch {
    return undefined;
  }
}

async function loadedPackages(pi: ExtensionAPI): Promise<string[]> {
  const sources = [
    fileURLToPath(import.meta.url),
    ...pi.getAllTools().map((tool) => tool.sourceInfo?.path),
    ...pi
      .getCommands()
      .filter((command) => command.source === 'extension')
      .map((command) => command.sourceInfo?.path),
  ];
  const manifests = await Promise.all(
    [...new Set(sources)].flatMap((source) =>
      source === undefined ? [] : [findManifest(source, PACKAGES)],
    ),
  );
  const unique = new Map(
    manifests.flatMap((manifest) => (manifest ? [[manifest.file, manifest] as const] : [])),
  );
  const entries = await Promise.all(
    [...unique.values()].map(async (manifest) => {
      const core = await coreVersion(manifest.file);
      return `${manifest.name} ${manifest.version}${core ? ` (core ${core})` : ''}`;
    }),
  );
  return [...new Set(entries)].sort();
}

async function toolchainStatus(
  cwd: string,
  transport: CommandTransport | null,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (signal?.aborted) return 'Toolchain probe cancelled.';
  if (!transport && process.platform === 'win32') {
    return 'Toolchain probe unavailable in a Windows local session.';
  }
  try {
    const executable = 'sh';
    const args = ['-c', PROBE, 'helper-doctor', ...TOOLS];
    const options = { cwd, signal, timeoutMs: 5000, maxBytes: 4096 };
    const run = await (transport
      ? transport.exec({ ...options, executable, args })
      : runLocalCommand(executable, args, options));
    if (run.cancelled) return 'Toolchain probe cancelled.';
    if (run.timedOut) return 'Toolchain probe timed out.';
    if (run.code !== 0 || run.truncated || run.stdioHeldOpen) return 'Toolchain probe unavailable.';
    const lines = new Set(run.stdout.split(/\r?\n/));
    const available = TOOLS.filter((tool) => lines.has(`PI_DOCTOR:${tool}`));
    const missing = TOOLS.filter((tool) => !available.includes(tool));
    return `Toolchain available: ${available.join(', ') || 'none'}\nToolchain missing: ${missing.join(', ') || 'none'}`;
  } catch {
    return 'Toolchain probe unavailable.';
  }
}

export function registerDoctorCommand(pi: ExtensionAPI): void {
  pi.registerCommand('helper-doctor', {
    description:
      'Show loaded helper versions, the active execution target, and available toolchains',
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (argument !== '') {
        ctx.ui.notify(USAGE, argument === '--help' || argument === '-h' ? 'info' : 'warning');
        return;
      }
      const transport = getTransport();
      let mappedCwd: string | undefined;
      try {
        mappedCwd = transport ? transport.mapCwd(ctx.cwd) : ctx.cwd;
      } catch {
        // An unmapped directory must never fall back to local execution.
      }
      const [piManifest, core, extensions, tools] = await Promise.all([
        findManifest(process.argv[1] ?? '', new Set([PI])),
        coreVersion(fileURLToPath(import.meta.url)),
        loadedPackages(pi),
        mappedCwd === undefined
          ? 'Toolchain probe skipped because the working directory is outside the active mapping.'
          : toolchainStatus(mappedCwd, transport, ctx.signal),
      ]);
      ctx.ui.notify(
        [
          `Pi ${piManifest?.version ?? 'unknown'} · Node ${process.versions.node}`,
          `${CORE} ${core ?? 'unknown'}`,
          ...extensions,
          `Target: ${transport?.id ?? 'local'}`,
          `Directory: ${ctx.cwd}${transport ? ` → ${mappedCwd ?? 'unmapped'}` : ''}`,
          tools,
        ].join('\n'),
        mappedCwd === undefined ? 'warning' : 'info',
      );
    },
  });
}
