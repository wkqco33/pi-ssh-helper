import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  buildInspectionScript,
  buildProbeScript,
  describeGaps,
  parseCapabilities,
  parseInspection,
  CAPABILITY_KEYS,
} from '../src/ssh/capability.ts';

test('a missing tool is reported as absent instead of being left undefined', () => {
  const capabilities = parseCapabilities('os=Linux\narch=x86_64\nbash=/bin/bash\n');
  assert.deepEqual(Object.keys(capabilities).sort(), [...CAPABILITY_KEYS].sort());
  assert.equal(capabilities.bash, '/bin/bash');
  assert.equal(capabilities.rsync, '');
  assert.equal(capabilities.ros2, '');
});

test('values keep their spaces and ignore unrelated lines', () => {
  const capabilities = parseCapabilities(
    'os=Linux\nkernel=bogus value\npython3=/usr/bin/python3\n',
  );
  assert.equal(capabilities.python3, '/usr/bin/python3');
  assert.equal(capabilities.os, 'Linux');
});

test('the inspection report normalizes distribution paths and versions', () => {
  const report = parseInspection(
    [
      'os=Linux',
      'bash=/usr/bin/bash',
      'kernel=Linux robot 6.1.0 aarch64 GNU/Linux',
      'bash_version=GNU bash, version 5.1.16(1)-release (aarch64-unknown-linux-gnu)',
      'python_version=Python 3.10.12',
      'ros_distros=/opt/ros/humble/,/opt/ros/iron/,',
    ].join('\n'),
  );
  assert.equal(report.capabilities.bash, '/usr/bin/bash');
  assert.deepEqual(report.rosDistros, ['/opt/ros/humble', '/opt/ros/iron']);
  assert.equal(report.pythonVersion, 'Python 3.10.12');
  assert.match(report.kernel, /aarch64/);
});

test('gaps name the consequence, not just the missing binary', () => {
  const gaps = describeGaps(parseCapabilities('bash=/bin/bash\n'));
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /ros2 CLI is missing/);
  const none = describeGaps(parseCapabilities('bash=/bin/bash\nros2=/usr/bin/ros2\n'));
  assert.deepEqual(none, []);
});

test('the probe script runs under a plain POSIX shell and reports this host', () => {
  // The probe must not depend on bash, since detecting bash is its job.
  const output = execFileSync('sh', ['-c', buildProbeScript()], { encoding: 'utf8' });
  const capabilities = parseCapabilities(output);
  assert.equal(capabilities.os, 'Linux');
  assert.notEqual(capabilities.bash, '');
  assert.notEqual(capabilities.arch, '');
});

test('the inspection script stays POSIX and completes on this host', () => {
  const output = execFileSync('sh', ['-c', buildInspectionScript()], { encoding: 'utf8' });
  const report = parseInspection(output);
  assert.equal(report.capabilities.os, 'Linux');
  assert.match(report.bashVersion, /bash/i);
});
