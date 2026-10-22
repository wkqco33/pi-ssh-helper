/**
 * What the remote side actually has.
 *
 * A remote host is often a robot image rather than a development machine:
 * `bash` may exist while `rsync` does not, and a BusyBox userland has no GNU
 * `timeout`. Probing first turns "the tool is broken" into a stated fact, and
 * the probe itself uses only POSIX `sh` builtins and `command -v` so it works
 * on the oldest host in the fleet.
 */

export const CAPABILITY_KEYS = [
  'os',
  'arch',
  'bash',
  'python3',
  'ros2',
  'colcon',
  'rsync',
  'sftp',
  'timeout',
  'docker',
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** Absolute path of each tool, or `''` when the host does not have it. */
export type Capabilities = Record<CapabilityKey, string>;

export interface CapabilityReport {
  capabilities: Capabilities;
  kernel: string;
  bashVersion: string;
  pythonVersion: string;
  /** ROS distributions installed under `/opt/ros`. */
  rosDistros: string[];
}

const PROBE_LINES: ReadonlyArray<readonly [CapabilityKey, string]> = [
  ['os', 'uname -s 2>/dev/null'],
  ['arch', 'uname -m 2>/dev/null'],
  ['bash', 'command -v bash 2>/dev/null'],
  ['python3', 'command -v python3 2>/dev/null'],
  ['ros2', 'command -v ros2 2>/dev/null'],
  ['colcon', 'command -v colcon 2>/dev/null'],
  ['rsync', 'command -v rsync 2>/dev/null'],
  ['sftp', 'command -v sftp 2>/dev/null'],
  ['timeout', 'command -v timeout 2>/dev/null'],
  ['docker', 'command -v docker 2>/dev/null'],
];

function printfLine(key: string, expression: string): string {
  return `printf '%s=%s\\n' ${key} "$(${expression})"`;
}

/** POSIX-only probe used by the lightweight host status tool. */
export function buildProbeScript(): string {
  return PROBE_LINES.map(([key, expression]) => printfLine(key, expression)).join('; ');
}

/** Probe plus versions and installed distributions, used by the details tool. */
export function buildInspectionScript(): string {
  return [
    buildProbeScript(),
    printfLine('kernel', 'uname -a 2>/dev/null'),
    printfLine('bash_version', 'bash --version 2>/dev/null | head -n 1'),
    printfLine('python_version', 'python3 -V 2>&1 | head -n 1'),
    printfLine('ros_distros', "ls -d /opt/ros/*/ 2>/dev/null | tr '\\n' ',' "),
  ].join('; ');
}

function parseKeyValues(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return values;
}

/** Normalizes a probe result; a missing key is reported as absent, not as unknown. */
export function parseCapabilities(stdout: string): Capabilities {
  const values = parseKeyValues(stdout);
  const capabilities = Object.fromEntries(
    CAPABILITY_KEYS.map((key) => [key, values.get(key) ?? '']),
  ) as Capabilities;
  return capabilities;
}

export function parseInspection(stdout: string): CapabilityReport {
  const values = parseKeyValues(stdout);
  return {
    capabilities: parseCapabilities(stdout),
    kernel: values.get('kernel') ?? '',
    bashVersion: values.get('bash_version') ?? '',
    pythonVersion: values.get('python_version') ?? '',
    rosDistros: (values.get('ros_distros') ?? '')
      .split(',')
      .map((entry) => entry.trim().replace(/\/$/, ''))
      .filter((entry) => entry !== ''),
  };
}

/** Human-readable gaps, so a tool can name what is missing instead of failing later. */
export function describeGaps(capabilities: Capabilities): string[] {
  const gaps: string[] = [];
  if (capabilities.bash === '')
    gaps.push('bash is missing, so the remote command wrapper cannot run');
  if (capabilities.ros2 === '')
    gaps.push('ros2 CLI is missing, so ROS helper tools cannot run remotely');
  return gaps;
}
