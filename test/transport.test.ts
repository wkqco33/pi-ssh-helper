import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toLocalPath, toRemotePath } from '../src/ssh/map.ts';
import { buildProfile } from '../src/ssh/profile.ts';
import {
  buildMasterArgs,
  buildSshArgs,
  createSshTransport,
  ensureControlMaster,
  probeHost,
  remoteProbeCommand,
} from '../src/ssh/transport.ts';

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

  // A prelude that exists on every host: this test runs on CI too, where a
  // machine-specific setup path would make it pass only locally.
  const withPrelude = buildProfile(
    'b',
    { remoteWorkspace: '/w', prelude: ['export PI_PROBE_PRELUDE=ok'] },
    [],
  );
  const command = remoteProbeCommand(withPrelude, 'printf "%s" "$PI_PROBE_PRELUDE"');
  assert.match(command, /^bash -lc '/);
  assert.match(command, /PI_PROBE_PRELUDE/);
  // One more shell layer, as ssh applies, must still reach the same probe.
  assert.equal(execFileSync('sh', ['-c', command], { encoding: 'utf8' }), 'ok');
});

test('a prelude line with quotes and spaces stays inside one shell argument', () => {
  const profile = buildProfile(
    'c',
    { remoteWorkspace: '/w', prelude: ['source "/opt/my ros/setup.bash"'] },
    [],
  );
  assert.equal(
    remoteProbeCommand(profile, 'printf hi'),
    `bash -lc 'source "/opt/my ros/setup.bash" && printf hi'`,
  );

  // An apostrophe in a prelude must be escaped for the outer shell layer
  // instead of closing it and turning the rest into a command.
  const apostrophe = buildProfile(
    'd',
    { remoteWorkspace: '/w', prelude: ["export LABEL='two words'"] },
    [],
  );
  const command = remoteProbeCommand(apostrophe, 'printf hi');
  assert.ok(command.includes(`'\\''`), command);
  assert.equal(
    execFileSync('sh', ['-c', `${command.replace('printf hi', 'printf "%s" "$LABEL"')}`], {
      encoding: 'utf8',
    }),
    'two words',
  );
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

const CONTAINER_PROFILE = buildProfile(
  'robot',
  {
    hostname: '10.0.0.5',
    user: 'robot',
    remoteWorkspace: '/home/robot/ws',
    container: 'cloi-robo-claw',
    containerWorkdir: '/ws',
    prelude: ['source /opt/ros/jazzy/setup.bash'],
  },
  [],
);

test('with a container, local paths map to the container mount, not the host checkout', () => {
  const transport = createSshTransport({ profile: CONTAINER_PROFILE, localRoot: '/home/me/ws' });
  assert.equal(transport.mapCwd('/home/me/ws'), '/ws');
  assert.equal(transport.mapCwd('/home/me/ws/src/pkg'), '/ws/src/pkg');
  assert.throws(() => transport.mapCwd('/home/me/other'), /outside the transport root/);
});

test('with a container, commands and the probe both run through docker exec', () => {
  const exec = remoteProbeCommand(CONTAINER_PROFILE, 'printf hi');
  assert.match(exec, /^docker exec /);
  assert.match(exec, /-w '\/ws'/);
  assert.match(exec, /'cloi-robo-claw' bash -lc /);
  // The prelude is part of the container probe, since the host has no ROS.
  assert.match(exec, /source \/opt\/ros\/jazzy\/setup\.bash/);
  assert.match(exec, /printf hi/);
});

test('a container exec sends docker exec with the mapped cwd to ssh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ssh-container-'));
  const originalPath = process.env.PATH;
  try {
    const fake = join(dir, 'ssh');
    await writeFile(fake, '#!/bin/sh\nfor arg in "$@"; do printf "%s\\n" "$arg"; done\n');
    await chmod(fake, 0o755);
    process.env.PATH = `${dir}:${originalPath ?? ''}`;

    const transport = createSshTransport({
      profile: CONTAINER_PROFILE,
      localRoot: '/home/me/ws',
      controlDir: join(dir, 'ctl'),
    });
    const result = await transport.exec({
      executable: 'ros2',
      args: ['node', 'list'],
      cwd: '/ws',
      timeoutMs: 20_000,
    });

    const remoteCommand = result.stdout.trim().split('\n').at(-1) ?? '';
    assert.match(remoteCommand, /^docker exec -w '\/ws' 'cloi-robo-claw' bash -lc /);
    assert.match(remoteCommand, /source \/opt\/ros\/jazzy\/setup\.bash/);
    assert.match(remoteCommand, /ros2/);
    assert.doesNotMatch(remoteCommand, /\/home\/me\/ws/);
  } finally {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test('the master warm-up opens no session and backgrounds itself', () => {
  const args = buildMasterArgs(PROFILE, '/tmp/ctl');
  assert.ok(args.includes('ControlMaster=auto'));
  assert.ok(args.includes('ControlPersist=600'));
  assert.ok(args.includes('-N'));
  assert.ok(args.includes('-f'));
  // The destination must be last: everything after it is a remote command.
  assert.equal(args.at(-1), 'robot@10.0.0.5');
  assert.equal(args.includes('echo hi'), false);
});

test(
  'the master is warmed up with ignored stdio so it cannot hold a caller pipe',
  { skip: existsSync('/proc/self/fd/1') ? false : 'needs /proc to observe the inherited fd' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-ssh-master-'));
    const originalPath = process.env.PATH;
    const originalMarker = process.env.PI_TEST_STDIO_MARKER;
    try {
      const marker = join(dir, 'stdio.txt');
      process.env.PI_TEST_STDIO_MARKER = marker;
      // Records what stdout the daemonized master would inherit.
      const fake = join(dir, 'ssh');
      await writeFile(
        fake,
        // fd 3 carries the report, and the command substitution keeps fd 1 at
        // what the master itself was given: redirecting the reporting command
        // would otherwise show the marker file instead of the inherited stdio.
        '#!/bin/sh\nexec 3> "$PI_TEST_STDIO_MARKER"\nprintf \'%s\\n\' "$(readlink /proc/$$/fd/1)" >&3\nexit 0\n',
      );
      await chmod(fake, 0o755);
      process.env.PATH = `${dir}:${originalPath ?? ''}`;

      await ensureControlMaster(PROFILE, join(dir, 'ctl'));

      const inherited = (await readFile(marker, 'utf8')).trim();
      assert.equal(inherited, '/dev/null');
    } finally {
      process.env.PATH = originalPath;
      if (originalMarker === undefined) delete process.env.PI_TEST_STDIO_MARKER;
      else process.env.PI_TEST_STDIO_MARKER = originalMarker;
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('the probe forwards an abort signal instead of waiting out its timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ssh-abort-'));
  const originalPath = process.env.PATH;
  try {
    const fake = join(dir, 'ssh');
    // Master warm-up returns; the probe itself ignores SIGTERM, so only the
    // abort path (SIGTERM → SIGKILL → report) can end it.
    await writeFile(
      fake,
      '#!/bin/sh\ncase " $* " in *" -N -f "*) exit 0;; esac\ntrap \'\' TERM\nsleep 30\n',
    );
    await chmod(fake, 0o755);
    process.env.PATH = `${dir}:${originalPath ?? ''}`;

    const controller = new AbortController();
    const started = Date.now();
    const promise = probeHost(PROFILE, {
      controlDir: join(dir, 'ctl'),
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    let watchdog: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error('probe did not settle')), 8_000);
      }),
    ]).finally(() => {
      if (watchdog) clearTimeout(watchdog);
    });

    assert.equal(outcome.result.cancelled, true);
    assert.ok(Date.now() - started < 8_000);
  } finally {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
});
