import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toLocalPath, toRemotePath } from '../src/ssh/map.ts';
import { buildProfile } from '../src/ssh/profile.ts';
import { buildSshArgs, createSshTransport, remoteProbeCommand } from '../src/ssh/transport.ts';

const PROFILE = buildProfile(
  'robot-01',
  { hostname: '10.0.0.5', user: 'robot', port: 2222, remoteWorkspace: '/home/robot/ws' },
  [],
);

test('the ssh invocation pins non-interactive, multiplexed settings', () => {
  const args = buildSshArgs(PROFILE, 'echo hi', '/tmp/ctl');
  assert.deepEqual(args.slice(0, 2), ['-o', 'BatchMode=yes']);
  assert.ok(args.includes('ControlMaster=auto'));
  assert.ok(args.includes('ControlPath=/tmp/ctl/%C'));
  assert.ok(args.includes('ControlPersist=600'));
  assert.ok(args.includes('ConnectTimeout=10'));
  assert.equal(args.at(-2), 'robot@10.0.0.5');
  assert.equal(args.at(-1), 'echo hi');
  assert.ok(args.includes('-p') && args.includes('2222'));
});

test('identity file and jump host reach ssh in the form it expects', () => {
  const profile = buildProfile(
    'jump',
    {
      hostname: '10.0.0.7',
      identityFile: '/home/me/.ssh/id_robot',
      proxyJump: 'bastion',
      remoteWorkspace: '/w',
    },
    [],
  );
  const args = buildSshArgs(profile, 'true', '/tmp/ctl');
  assert.equal(args[args.indexOf('-i') + 1], '/home/me/.ssh/id_robot');
  assert.equal(args[args.indexOf('-J') + 1], 'bastion');
  assert.equal(args.at(-2), '10.0.0.7');
});

test('paths map in both directions through the same roots', () => {
  const mapping = { localRoot: '/home/me/ws', remoteRoot: '/home/robot/ws' };
  assert.equal(toRemotePath('/home/me/ws/src', mapping), '/home/robot/ws/src');
  assert.equal(toLocalPath('/home/robot/ws/logs/run.txt', mapping), '/home/me/ws/logs/run.txt');
  assert.throws(() => toLocalPath('/var/log/syslog', mapping), /outside the transport root/);
});

test('the probe uses the same prelude as real commands, so it measures the same shell', () => {
  const bare = buildProfile('a', { remoteWorkspace: '/w' }, []);
  assert.equal(remoteProbeCommand(bare, 'printf hi'), 'printf hi');

  const withPrelude = buildProfile(
    'b',
    { remoteWorkspace: '/w', prelude: ['source /opt/ros/jazzy/setup.bash'] },
    [],
  );
  const command = remoteProbeCommand(withPrelude, 'printf hi');
  assert.match(command, /^bash -lc '/);
  assert.match(command, /source \/opt\/ros\/jazzy\/setup\.bash/);
  assert.match(command, /printf hi/);
  // One more shell layer must still reach the same probe.
  assert.equal(execFileSync('sh', ['-c', command], { encoding: 'utf8' }), 'hi');
});

test('the working directory is mapped and an unmappable one is refused', () => {
  const transport = createSshTransport({ profile: PROFILE, localRoot: '/home/me/ws' });
  assert.equal(transport.id, 'ssh:robot-01');
  assert.equal(transport.mapCwd('/home/me/ws/src/pkg'), '/home/robot/ws/src/pkg');
  assert.throws(() => transport.mapCwd('/home/me/other'), /outside the transport root/);
});

test('exec runs ssh locally and sends the mapped cwd inside the remote command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ssh-fake-'));
  const originalPath = process.env.PATH;
  try {
    // A fake `ssh` that prints its own argv, so the test observes exactly what
    // would have been handed to the real client.
    const fake = join(dir, 'ssh');
    await writeFile(fake, '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n" "$arg"; done\n');
    await chmod(fake, 0o755);
    process.env.PATH = `${dir}:${originalPath ?? ''}`;

    const transport = createSshTransport({
      profile: PROFILE,
      localRoot: '/home/me/ws',
      controlDir: join(dir, 'ctl'),
    });
    const result = await transport.exec({
      executable: 'ros2',
      args: ['node', 'list'],
      cwd: '/home/robot/ws/pkg',
      timeoutMs: 20_000,
    });

    assert.equal(result.code, 0);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.at(-2), 'robot@10.0.0.5');
    const remoteCommand = lines.at(-1) ?? '';
    assert.match(remoteCommand, /^bash -lc '/);
    // The remote side gets the remote path; the local one must not leak.
    assert.match(remoteCommand, /\/home\/robot\/ws\/pkg/);
    assert.doesNotMatch(remoteCommand, /\/home\/me\/ws/);
    // The script is quoted for the remote login shell, so the assertions look
    // for the escaped form the client actually sends.
    assert.match(remoteCommand, /ros2/);
    assert.match(remoteCommand, /node/);
    assert.match(remoteCommand, /list/);
  } finally {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
});
