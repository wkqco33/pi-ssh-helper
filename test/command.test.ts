import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRemoteCommand, buildRemoteScript, wrapContainer } from '../src/ssh/command.ts';

function runLocally(script: string, cwd: string): string {
  // The same `bash -lc` wrapper the remote side uses, so the quoting under test
  // is exercised exactly as it will be over ssh.
  return execFileSync('bash', ['-lc', script], { encoding: 'utf8', cwd });
}

test('the script changes directory, exports the overlay, and executes the command', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-ssh-command-'));
  try {
    const script = buildRemoteScript({
      cwd,
      env: { ROS_DOMAIN_ID: '42' },
      executable: 'sh',
      args: ['-c', 'printf "%s|%s" "$PWD" "$ROS_DOMAIN_ID"'],
    });
    assert.equal(runLocally(script, cwd), `${cwd}|42`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('prelude lines run before the command and in order', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-ssh-command-'));
  try {
    const script = buildRemoteScript({
      cwd,
      prelude: ['export REMOTE_STAGE=one', 'export REMOTE_NEXT=$REMOTE_STAGE-two'],
      executable: 'sh',
      args: ['-c', 'printf "%s" "$REMOTE_NEXT"'],
    });
    assert.equal(runLocally(script, cwd), 'one-two');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a path with spaces and a substitution reaches the command as data', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi ssh command '));
  try {
    const script = buildRemoteScript({
      cwd,
      executable: 'sh',
      args: ['-c', 'printf "%s" "$PWD"'],
    });
    assert.equal(runLocally(script, cwd), cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('an invalid environment name is refused instead of being injected into the script', () => {
  assert.throws(
    () =>
      buildRemoteScript({
        cwd: '/tmp',
        env: { 'BAD NAME': 'x' },
        executable: 'true',
        args: [],
      }),
    /not a shell variable name/,
  );
});

test('the command wrapper adds exactly one shell layer around the script', () => {
  const script = buildRemoteScript({ cwd: '/tmp', executable: 'echo', args: ['hi'] });
  const command = buildRemoteCommand({ cwd: '/tmp', executable: 'echo', args: ['hi'] });
  assert.equal(command, `bash -lc '${script.replace(/'/g, `'\\''`)}'`);
  // Running the whole command through one more shell, as ssh does, must still
  // reach the same executable with the same argument.
  assert.equal(execFileSync('sh', ['-c', command], { encoding: 'utf8' }), 'hi\n');
});

test('a command is executed, not left with the wrapper shell as its parent', () => {
  const script = buildRemoteScript({ cwd: '/tmp', executable: 'sh', args: ['-c', 'printf done'] });
  const lines = script.split(' && ');
  assert.equal(lines.at(-1), "exec 'sh' '-c' 'printf done'");
});

test('a container command sets the working directory with docker exec -w', () => {
  const wrapped = wrapContainer('printf hi', '/ws', { name: 'cloi-robo-claw', workdir: '/ws' });
  assert.equal(wrapped, `docker exec -w '/ws' 'cloi-robo-claw' bash -lc 'printf hi'`);
});

test('a container command without a cwd relies on the configured workdir', () => {
  const wrapped = wrapContainer('printf hi', undefined, { name: 'box', workdir: '/ws' });
  assert.equal(wrapped, `docker exec 'box' bash -lc 'printf hi'`);
});

test('the wrapped command really changes directory and runs inside the container', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-ssh-docker-'));
  const originalPath = process.env.PATH;
  try {
    // A fake `docker` that honours `exec -w DIR NAME cmd...` by changing
    // directory and running the command, which is what the real client does.
    const fake = join(dir, 'docker');
    writeFileSync(
      fake,
      '#!/bin/sh\nshift\nif [ "$1" = "-w" ]; then cd "$2" || exit 1; shift 2; fi\nshift\nexec "$@"\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${dir}:${originalPath ?? ''}`;

    const wrapped = wrapContainer('printf "%s" "$PWD"', dir, { name: 'box', workdir: '/' });
    assert.equal(execFileSync('sh', ['-c', wrapped], { encoding: 'utf8' }), dir);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a relative container cwd is rejected instead of being resolved by docker', () => {
  assert.throws(
    () => wrapContainer('printf hi', 'ws', { name: 'box', workdir: '/ws' }),
    /container cwd must be an absolute path/,
  );
});
