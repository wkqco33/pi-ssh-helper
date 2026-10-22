import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import extension from '../extensions/index.ts';

type RegisteredTool = Parameters<ExtensionAPI['registerTool']>[0];
type RegisteredCommand = Parameters<ExtensionAPI['registerCommand']>[1];

interface Harness {
  tools: RegisteredTool[];
  commands: { name: string; options: RegisteredCommand }[];
  events: string[];
}

function loadExtension(): Harness {
  const harness: Harness = { tools: [], commands: [], events: [] };
  const pi = {
    registerTool: (tool: RegisteredTool) => harness.tools.push(tool),
    registerCommand: (name: string, options: RegisteredCommand) =>
      harness.commands.push({ name, options }),
    on: (event: string) => harness.events.push(event),
  } as unknown as ExtensionAPI;
  extension(pi);
  return harness;
}

function toolContext(cwd: string): ExtensionToolContext {
  return {
    cwd,
    ui: { notify: () => undefined, setStatus: () => undefined },
  } as unknown as ExtensionToolContext;
}

async function callTool(
  tool: RegisteredTool,
  params: unknown,
  cwd: string,
): Promise<{ content: { text: string }[]; details: Record<string, unknown> }> {
  const output = await tool.execute(
    'test-call',
    params as never,
    undefined,
    undefined,
    toolContext(cwd),
  );
  return output as unknown as { content: { text: string }[]; details: Record<string, unknown> };
}

test('the extension registers its three tools, its command, and the shutdown hook', () => {
  const { tools, commands, events } = loadExtension();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'ssh_detect_capabilities',
    'ssh_exec',
    'ssh_host_status',
  ]);
  assert.deepEqual(
    commands.map((command) => command.name),
    ['ssh-remote'],
  );
  assert.ok(events.includes('session_shutdown'));
  assert.deepEqual(
    tools
      .filter((tool) => tool.annotations?.readOnlyHint === true)
      .map((tool) => tool.name)
      .sort(),
    ['ssh_detect_capabilities', 'ssh_host_status'],
  );
});

test('a mutating remote command is refused before ssh is ever spawned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ssh-tools-'));
  const originalConfig = process.env.PI_SSH_HELPER_CONFIG;
  try {
    const configPath = join(dir, 'ssh-helper.json');
    await writeFile(
      configPath,
      JSON.stringify({
        hosts: {
          robot: { hostname: '127.0.0.1', remoteWorkspace: '/home/robot/ws', allowMutating: false },
        },
      }),
    );
    process.env.PI_SSH_HELPER_CONFIG = configPath;

    const { tools } = loadExtension();
    const exec = tools.find((tool) => tool.name === 'ssh_exec');
    assert.ok(exec);

    // PATH points at an empty directory: any attempt to spawn ssh would fail
    // loudly rather than silently reaching a real host.
    const originalPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      const output = await callTool(exec, { host: 'robot', command: 'rm -rf build' }, dir);
      const details = output.details as {
        ok: boolean;
        errors: { code: string }[];
        data: { risk: string };
      };
      assert.equal(details.ok, false);
      assert.equal(details.data.risk, 'irreversible');
      assert.equal(details.errors[0].code, 'SSH_MUTATION_NOT_ALLOWED');
    } finally {
      process.env.PATH = originalPath;
    }
  } finally {
    if (originalConfig === undefined) delete process.env.PI_SSH_HELPER_CONFIG;
    else process.env.PI_SSH_HELPER_CONFIG = originalConfig;
    await rm(dir, { recursive: true, force: true });
  }
});

test('a host that is not configured is reported as a config problem, not as a command failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ssh-tools-'));
  const originalConfig = process.env.PI_SSH_HELPER_CONFIG;
  try {
    process.env.PI_SSH_HELPER_CONFIG = join(dir, 'absent.json');
    const { tools } = loadExtension();
    const status = tools.find((tool) => tool.name === 'ssh_host_status');
    assert.ok(status);

    const output = await callTool(status, {}, dir);
    const details = output.details as { ok: boolean; errors: { code: string }[] };
    assert.equal(details.ok, false);
    assert.equal(details.errors[0].code, 'SSH_CONFIG_INVALID');
  } finally {
    if (originalConfig === undefined) delete process.env.PI_SSH_HELPER_CONFIG;
    else process.env.PI_SSH_HELPER_CONFIG = originalConfig;
    await rm(dir, { recursive: true, force: true });
  }
});
