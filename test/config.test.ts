import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultConfigPath,
  defaultControlDirPath,
  knownAliases,
  loadHelperConfig,
  loadSshConfig,
  parseHelperConfig,
} from '../src/ssh/config.ts';
import { parseSshConfig } from '../src/ssh/profile.ts';

const VALID = JSON.stringify({
  defaultHost: 'robot-01',
  hosts: {
    'robot-01': {
      hostname: '10.0.0.5',
      user: 'robot',
      remoteWorkspace: '/home/robot/ws',
      prelude: ['source /opt/ros/humble/setup.bash'],
    },
  },
});

test('a valid config is parsed with its default host', () => {
  const config = parseHelperConfig(VALID, 'test.json');
  assert.equal(config.defaultHost, 'robot-01');
  assert.equal(config.hosts['robot-01'].remoteWorkspace, '/home/robot/ws');
});

test('a typo in a key is rejected instead of silently ignored', () => {
  assert.throws(() => parseHelperConfig('{"host":{}}', 'test.json'), /unknown key "host"/);
  assert.throws(
    () =>
      parseHelperConfig(JSON.stringify({ hosts: { a: { remoteWorksapce: '/w' } } }), 'test.json'),
    /host a has unknown key "remoteWorksapce"/,
  );
});

test('override values are type-checked, because a truthy string would enable mutation', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ allowMutating: 'yes' }, /host a\.allowMutating must be a boolean/],
    [{ port: '22' }, /host a\.port must be an integer/],
    [{ prelude: 'source /opt/ros/humble/setup.bash' }, /host a\.prelude must be a list of strings/],
    [{ remoteWorkspace: 42 }, /host a\.remoteWorkspace must be a string/],
  ];
  for (const [override, expected] of cases) {
    assert.throws(
      () => parseHelperConfig(JSON.stringify({ hosts: { a: override } }), 'test.json'),
      expected,
    );
  }
});

test('a default host that is not defined is rejected', () => {
  assert.throws(
    () => parseHelperConfig('{"defaultHost":"nope","hosts":{}}', 'test.json'),
    /defaultHost nope is not defined/,
  );
});

test('invalid JSON names the file it came from', () => {
  assert.throws(
    () => parseHelperConfig('{', '/tmp/broken.json'),
    /\/tmp\/broken\.json: invalid JSON/,
  );
});

test('a missing config file is an empty config, not a failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ssh-config-'));
  try {
    assert.deepEqual(await loadHelperConfig(join(dir, 'absent.json')), { hosts: {} });
    assert.deepEqual(await loadSshConfig(join(dir, 'no-ssh-config')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('both config files are read from disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ssh-config-'));
  try {
    const helperPath = join(dir, 'ssh-helper.json');
    const sshPath = join(dir, 'config');
    await writeFile(helperPath, VALID);
    await writeFile(sshPath, 'Host robot-09\n  HostName 10.0.0.9\n');
    const config = await loadHelperConfig(helperPath);
    const sshHosts = await loadSshConfig(sshPath);
    assert.equal(config.hosts['robot-01'].user, 'robot');
    assert.equal(sshHosts[0].hostname, '10.0.0.9');
    assert.deepEqual(knownAliases(config, sshHosts), ['robot-01', 'robot-09']);
    assert.equal(await readFile(helperPath, 'utf8'), VALID);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('wildcard patterns are not listed as aliases a user can type', () => {
  const sshHosts = parseSshConfig(
    'Host lab-*\n  HostName lab.internal\nHost exact\n  HostName 1.2.3.4\n',
  );
  assert.deepEqual(knownAliases({ hosts: { mine: { remoteWorkspace: '/w' } } }, sshHosts), [
    'exact',
    'mine',
  ]);
});

test('environment overrides replace the default paths', () => {
  assert.equal(
    defaultConfigPath({ PI_SSH_HELPER_CONFIG: '/tmp/x.json' } as NodeJS.ProcessEnv),
    '/tmp/x.json',
  );
  assert.equal(
    defaultControlDirPath({ PI_SSH_HELPER_CONTROL_DIR: '/tmp/ctl' } as NodeJS.ProcessEnv),
    '/tmp/ctl',
  );
  assert.match(defaultConfigPath({} as NodeJS.ProcessEnv), /\.pi\/agent\/ssh-helper\.json$/);
});
