import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { setTransport } from 'pi-helper-core';
import sshExtension from '../../extensions/index.ts';
import { buildProfile } from '../../src/ssh/profile.ts';
import { createSshTransport } from '../../src/ssh/transport.ts';

const fakeSsh = `#!/bin/sh
for arg; do
  case "$arg" in
    -N) exit 0 ;;
  esac
  last="$arg"
done
case "$last" in
  *"/remote/pi-routing-fixture"*status*--porcelain=v1*) operation=status ;;
  *"/remote/pi-routing-fixture"*rev-parse*--show-prefix*) operation=prefix ;;
  *) exit 117 ;;
esac
printf '%s\\n' "$operation" >> "$PI_ROUTING_TEST_LOG"
if [ "$operation" = prefix ]; then printf '\\n'; fi
`;

test('all three language extensions route Git discovery through the SSH transport', async (t) => {
  const workspace = resolve(process.env.PI_HELPER_WORKSPACE ?? '..');
  const dir = await mkdtemp(join(tmpdir(), 'pi-helper-routing-'));
  const previousPath = process.env.PATH;
  const previousLog = process.env.PI_ROUTING_TEST_LOG;
  t.after(async () => {
    setTransport(null);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.PI_ROUTING_TEST_LOG;
    else process.env.PI_ROUTING_TEST_LOG = previousLog;
    await rm(dir, { force: true, recursive: true });
  });

  const bin = join(dir, 'bin');
  const log = join(dir, 'ssh.log');
  await mkdir(bin);
  await writeFile(join(bin, 'ssh'), fakeSsh, { mode: 0o700 });
  await writeFile(
    join(dir, 'Cargo.toml'),
    '[package]\nname = "routing-fixture"\nversion = "0.1.0"\n',
  );
  await writeFile(join(dir, 'pyproject.toml'), '[project]\nname = "routing-fixture"\n');
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  process.env.PI_ROUTING_TEST_LOG = log;

  const tools = new Map<string, ToolDefinition>();
  const commands = new Set<string>();
  const api = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string) => commands.add(name),
    on: () => () => undefined,
  } as unknown as ExtensionAPI;
  sshExtension(api);
  assert.ok(commands.has('ssh-remote'));
  const extensions = [
    ['pi-python-helper', 'py_tdd_checkpoint'],
    ['pi-ros-helper', 'ros_tdd_checkpoint'],
    ['pi-rust-helper', 'rust_tdd_checkpoint'],
  ] as const;
  for (const [packageName] of extensions) {
    const entry = pathToFileURL(join(workspace, packageName, 'extensions', 'index.ts')).href;
    const { default: extension } = (await import(entry)) as { default: ExtensionFactory };
    await extension(api);
  }

  const profile = buildProfile(
    'routing-fixture',
    { hostname: 'localhost', remoteWorkspace: '/remote/pi-routing-fixture' },
    [],
  );
  setTransport(createSshTransport({ profile, localRoot: dir, controlDir: join(dir, 'control') }));
  const context = { cwd: dir } as Parameters<ToolDefinition['execute']>[4];
  for (const [, name] of extensions) {
    const tool = tools.get(name);
    assert.ok(tool, `${name} was not registered`);
    await writeFile(log, '');
    const outcome = await tool.execute('fixture', {}, undefined, undefined, context);
    assert.equal(
      (outcome.details as { ok: boolean }).ok,
      true,
      `${name} did not receive Git evidence`,
    );
    assert.deepEqual(
      (await readFile(log, 'utf8')).trim().split('\n').sort(),
      ['prefix', 'status'],
      name,
    );
  }
});
