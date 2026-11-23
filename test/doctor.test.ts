import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { setTransport } from 'pi-helper-core';
import extension from '../extensions/index.ts';

test('doctor reports loaded package versions, current route, and bounded toolchain detection', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-helper-doctor-'));
  t.after(async () => {
    setTransport(null);
    await rm(dir, { recursive: true, force: true });
  });
  const extensionPath = join(dir, 'extensions', 'index.ts');
  await mkdir(dirname(extensionPath));
  await writeFile(extensionPath, '');
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'pi-python-helper', version: '9.8.7' }),
  );
  const calls: string[] = [];
  let mapped = true;
  setTransport({
    id: 'ssh:fixture',
    mapCwd(cwd) {
      if (!mapped || cwd !== dir) throw new Error('fixture map failed');
      return '/remote/workspace';
    },
    async exec(spec) {
      calls.push(spec.executable);
      assert.equal(spec.cwd, '/remote/workspace');
      assert.ok(spec.timeoutMs && spec.timeoutMs <= 5000);
      return {
        code: 0,
        stdout: 'PI_DOCTOR:git\nPI_DOCTOR:python3\n',
        stderr: 'fixture-secret',
        timedOut: false,
        cancelled: false,
        truncated: false,
        durationMs: 1,
      };
    },
  });

  type Handler = (args: string, context: ExtensionCommandContext) => Promise<void>;
  const commands = new Map<string, Handler>();
  const notifications: string[] = [];
  extension({
    registerCommand(name: string, command: { handler: Handler }) {
      commands.set(name, command.handler);
    },
    registerTool() {},
    on() {},
    getAllTools: () => [{ sourceInfo: { path: extensionPath } }],
    getCommands: () => [],
  } as unknown as ExtensionAPI);
  const context = {
    cwd: dir,
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionCommandContext;

  const doctor = commands.get('helper-doctor');
  assert.ok(doctor);
  await doctor('--help', context);
  assert.match(notifications.pop() ?? '', /usage: \/helper-doctor/);
  assert.deepEqual(calls, []);
  await doctor('', context);
  const report = notifications.pop() ?? '';
  assert.match(report, /Pi .*Node/);
  assert.match(report, /pi-helper-core \d/);
  assert.match(report, /pi-python-helper 9\.8\.7/);
  assert.match(report, /ssh:fixture/);
  assert.match(report, /\/remote\/workspace/);
  assert.match(report, /available: git, python3/);
  assert.doesNotMatch(report, /fixture-secret/);
  assert.deepEqual(calls, ['sh']);
  mapped = false;
  await doctor('', context);
  assert.match(notifications.pop() ?? '', /outside the active mapping/);
  assert.deepEqual(calls, ['sh']);
});
