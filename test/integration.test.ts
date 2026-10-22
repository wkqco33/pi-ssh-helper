import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, setTransport } from 'pi-helper-core';
import { buildProfile } from '../src/ssh/profile.ts';
import { createSshTransport } from '../src/ssh/transport.ts';

/**
 * End-to-end proof of the seam, without a second machine.
 *
 * A fake `ssh` stands in for the remote side and executes the command it is
 * handed, so the whole path is exercised: `runCommand` → transport → quoting →
 * `bash -lc` → the real executable. The machine is both ends here, which is
 * exactly why the assertion is about the *seam* and not about a remote host.
 */
const ROS_SETUP = '/opt/ros/jazzy/setup.bash';
const ROS_BINARY = '/opt/ros/jazzy/bin/ros2';
const rosAvailable = existsSync(ROS_SETUP) && existsSync(ROS_BINARY);

test(
  'a helper command routed through the transport reaches the far side of ssh',
  { skip: rosAvailable ? false : `ROS not installed at ${ROS_SETUP}` },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-ssh-seam-'));
    const originalPath = process.env.PATH;
    try {
      const fake = join(dir, 'ssh');
      await writeFile(fake, '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n');
      await chmod(fake, 0o755);
      process.env.PATH = `${dir}:${originalPath ?? ''}`;

      const profile = buildProfile(
        'self',
        { hostname: 'localhost', remoteWorkspace: dir, prelude: [`source ${ROS_SETUP}`] },
        [],
      );
      setTransport(createSshTransport({ profile, localRoot: dir, controlDir: join(dir, 'ctl') }));

      // `ros2` only resolves because the prelude sourced the ROS setup on the
      // "remote" side; nothing in this process sources it.
      const result = await runCommand('ros2', ['node', 'list'], {
        cwd: dir,
        timeoutMs: 90_000,
        maxBytes: 64 * 1024,
      });

      assert.equal(result.code, 0, `ros2 failed: ${result.stderr}`);
      assert.equal(result.timedOut, false);
    } finally {
      setTransport(null);
      process.env.PATH = originalPath;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
