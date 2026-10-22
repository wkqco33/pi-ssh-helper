import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSshConfig, buildProfile, findSshHost, sshDestination } from '../src/ssh/profile.ts';

const SSH_CONFIG = `
# personal defaults
Host *
  User robot
  IdentityFile ~/.ssh/id_robot

Host robot-01
  HostName 10.0.0.5
  Port 2222

Host robot-02
  HostName 10.0.0.6
  User admin
  ProxyJump bastion

Host lab-*
  HostName lab.internal
`;

test('ssh_config blocks are parsed with their patterns and keywords', () => {
  const hosts = parseSshConfig(SSH_CONFIG);
  assert.deepEqual(
    hosts.map((host) => host.patterns),
    [['*'], ['robot-01'], ['robot-02'], ['lab-*']],
  );
  assert.equal(hosts[1].hostname, '10.0.0.5');
  assert.equal(hosts[1].port, 2222);
  assert.equal(hosts[2].proxyJump, 'bastion');
});

test('a wildcard block supplies the defaults a later block leaves out, like ssh does', () => {
  const hosts = parseSshConfig(SSH_CONFIG);
  const robotOne = findSshHost('robot-01', hosts);
  assert.equal(robotOne?.user, 'robot');
  assert.equal(robotOne?.hostname, '10.0.0.5');
  // ssh keeps the *first* value it obtains for each keyword, so a `Host *`
  // block placed above a specific one wins for the keywords it sets. That is
  // ssh's documented rule and this resolver copies it rather than inventing a
  // more intuitive one, because the same file must mean the same thing here.
  assert.equal(findSshHost('robot-02', hosts)?.user, 'robot');
  assert.equal(findSshHost('lab-3', hosts)?.hostname, 'lab.internal');
  // Even an unknown host picks up `Host *` defaults; only the hostname stays unset.
  assert.equal(findSshHost('unknown-host', hosts)?.hostname, undefined);
  assert.equal(findSshHost('unknown-host', hosts)?.user, 'robot');
});

test('a specific block placed before the wildcard wins, which is why order matters', () => {
  const hosts = parseSshConfig(
    'Host robot-02\n  User admin\nHost *\n  User robot\n  IdentityFile ~/.ssh/id_robot\n',
  );
  const resolved = findSshHost('robot-02', hosts);
  assert.equal(resolved?.user, 'admin');
  assert.equal(resolved?.identityFile, '~/.ssh/id_robot');
});

test('an alias with no ssh_config entry still resolves to itself', () => {
  const profile = buildProfile('gpu-box', { remoteWorkspace: '/srv/ws' }, []);
  assert.equal(profile.hostname, 'gpu-box');
  assert.equal(profile.user, undefined);
  assert.equal(profile.allowMutating, false);
  assert.equal(profile.prelude.length, 0);
  assert.equal(sshDestination(profile), 'gpu-box');
});

test('overrides win per field, and the rest comes from ssh_config', () => {
  const hosts = parseSshConfig(SSH_CONFIG);
  const profile = buildProfile(
    'robot-01',
    {
      remoteWorkspace: '/home/robot/ws',
      localWorkspace: '/home/me/ws',
      prelude: ['source /opt/ros/humble/setup.bash'],
    },
    hosts,
  );
  assert.equal(profile.hostname, '10.0.0.5');
  assert.equal(profile.port, 2222);
  assert.equal(profile.user, 'robot');
  assert.equal(profile.remoteWorkspace, '/home/robot/ws');
  assert.equal(profile.prelude[0], 'source /opt/ros/humble/setup.bash');
  assert.equal(sshDestination(profile), 'robot@10.0.0.5');
});

test('a missing remoteWorkspace is refused rather than guessed', () => {
  assert.throws(
    () => buildProfile('robot-01', {}, parseSshConfig(SSH_CONFIG)),
    /remoteWorkspace is required/,
  );
});

test('invalid connection values are refused with the host named', () => {
  assert.throws(
    () => buildProfile('-oProxyCommand=x', { remoteWorkspace: '/w' }, []),
    /host alias/,
  );
  assert.throws(
    () => buildProfile('ok', { hostname: '-oProxyCommand=x', remoteWorkspace: '/w' }, []),
    /invalid hostname/,
  );
  assert.throws(
    () => buildProfile('ok', { user: 'a b', remoteWorkspace: '/w' }, []),
    /invalid user/,
  );
  assert.throws(() => buildProfile('ok', { port: 0, remoteWorkspace: '/w' }, []), /port must be/);
  assert.throws(
    () => buildProfile('ok', { port: 70_000, remoteWorkspace: '/w' }, []),
    /port must be/,
  );
  assert.throws(
    () => buildProfile('ok', { remoteWorkspace: 'relative/ws' }, []),
    /remoteWorkspace must be an absolute path/,
  );
  assert.throws(
    () => buildProfile('ok', { remoteWorkspace: '/w', prelude: ['  '] }, []),
    /prelude must be a list/,
  );
  assert.throws(
    () => buildProfile('ok', { remoteWorkspace: '/w', connectTimeoutSeconds: 0 }, []),
    /connectTimeoutSeconds/,
  );
});
