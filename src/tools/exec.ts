import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { classifyCommand } from 'pi-helper-core';
import { loadHostCatalog, profileFor } from '../hosts.ts';
import { defaultControlDirPath } from '../ssh/config.ts';
import type { RemoteProfile } from '../ssh/profile.ts';
import { runRemoteShell } from '../ssh/shell.ts';
import type { ContainerContext } from '../ssh/command.ts';
import { HOST_PARAM, clip, failed, result, sshFailureMessage, text } from './common.ts';

export function registerExecTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'ssh_exec',
    label: 'SSH Exec',
    description:
      'Run one shell command on a remote host over SSH and return its bounded output. Read-only commands run directly; mutating or irreversible commands require "allowMutating": true for the host in ~/.pi/agent/ssh-helper.json and allowMutating: true in the call.',
    promptSnippet: 'Run a shell command on a remote host over SSH',
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command line to run on the remote host' }),
      host: HOST_PARAM,
      cwd: Type.Optional(
        Type.String({
          description: 'Remote absolute working directory. Defaults to the host remoteWorkspace.',
        }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Number({ description: 'Wall-clock timeout in seconds. Defaults to 120.' }),
      ),
      allowMutating: Type.Optional(
        Type.Boolean({
          description:
            'Acknowledge that this command changes remote state. Still requires allowMutating for the host in config.',
        }),
      ),
      container: Type.Optional(
        Type.String({
          description:
            'Run inside this Docker container instead of on the host. Use it when the toolchain lives in a container, e.g. a robot ROS gateway. The default cwd becomes the host containerWorkdir.',
        }),
      ),
    }),
    annotations: { destructiveHint: true, openWorldHint: true },
    async execute(_id, params, signal, _update, ctx) {
      const started = Date.now();
      let profile: RemoteProfile;
      try {
        profile = profileFor(await loadHostCatalog(), params.host);
      } catch (error) {
        return failed(ctx.cwd, started, (error as Error).message, 'SSH_CONFIG_INVALID');
      }

      const classification = classifyCommand(params.command);
      const requiresOptIn = classification.risk !== 'read';
      if (requiresOptIn && !(profile.allowMutating && params.allowMutating === true)) {
        return failed(
          ctx.cwd,
          started,
          `refusing to run a ${classification.risk} command on ${profile.alias}: remote mutation is not enabled for this host`,
          'SSH_MUTATION_NOT_ALLOWED',
          {
            data: {
              command: params.command,
              risk: classification.risk,
              reasons: classification.reasons,
            },
            suggestions: [
              {
                message: `Set "allowMutating": true for host "${profile.alias}" in ~/.pi/agent/ssh-helper.json, then pass allowMutating: true.`,
                confidence: 'high',
              },
              {
                message:
                  'A read-only inspection command is usually enough to diagnose the problem; prefer that first.',
                confidence: 'medium',
              },
            ],
          },
        );
      }

      let container: ContainerContext | undefined;
      if (params.container !== undefined) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(params.container)) {
          return failed(
            ctx.cwd,
            started,
            `invalid container name ${JSON.stringify(params.container)}`,
            'SSH_INVALID_CONTAINER',
          );
        }
        container = {
          name: params.container,
          workdir: profile.containerWorkdir ?? profile.remoteWorkspace,
        };
      }

      const timeoutSeconds = params.timeoutSeconds ?? 120;
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        return failed(
          ctx.cwd,
          started,
          `timeoutSeconds must be positive (got ${timeoutSeconds})`,
          'SSH_INVALID_TIMEOUT',
        );
      }

      const effectiveCwd = params.cwd ?? container?.workdir ?? profile.remoteWorkspace;
      const run = await runRemoteShell(profile, defaultControlDirPath(), {
        command: params.command,
        cwd: effectiveCwd,
        timeoutMs: timeoutSeconds * 1000,
        signal,
        container,
      });

      const stdout = clip(run.stdout);
      const stderr = clip(run.stderr);
      const succeeded = run.code === 0 && !run.timedOut && !run.cancelled;
      const data = {
        alias: profile.alias,
        hostname: profile.hostname,
        command: params.command,
        cwd: effectiveCwd,
        container: container?.name ?? null,
        risk: classification.risk,
        exitCode: run.code,
        stdout: stdout.text,
        stderr: stderr.text,
        timedOut: run.timedOut,
        cancelled: run.cancelled,
        truncated: run.truncated || stdout.truncated || stderr.truncated,
        durationMs: run.durationMs,
      };

      return text(
        result(ctx.cwd, started, {
          ok: succeeded,
          summary: succeeded
            ? `${profile.alias}${container === undefined ? '' : ` (container ${container.name})`}: command succeeded (${run.durationMs}ms)`
            : `${profile.alias}${container === undefined ? '' : ` (container ${container.name})`}: command failed (${sshFailureMessage(run.stderr, run.code, run.timedOut)})`,
          data,
          evidence: [
            {
              kind: 'ssh-exec',
              message: `${profile.alias}${container === undefined ? '' : `:${container.name}`}: ${params.command}`,
            },
            { kind: 'ssh-exit', message: String(run.code) },
          ],
          warnings:
            classification.risk === 'read'
              ? []
              : [
                  {
                    code: 'MUTATING_COMMAND',
                    message: `classified as ${classification.risk}: ${classification.reasons.map((reason) => reason.reason).join('; ')}`,
                    severity: 'warning' as const,
                  },
                ],
          errors: succeeded
            ? []
            : [
                {
                  code: run.timedOut ? 'SSH_TIMEOUT' : 'REMOTE_COMMAND_FAILED',
                  message: sshFailureMessage(run.stderr, run.code, run.timedOut),
                  severity: 'error' as const,
                },
              ],
          suggestions: succeeded
            ? []
            : [
                {
                  message:
                    'The remote command ran and failed; read stderr for the first actionable line.',
                  confidence: 'high',
                },
              ],
          truncated: data.truncated,
        }),
      );
    },
  });
}
