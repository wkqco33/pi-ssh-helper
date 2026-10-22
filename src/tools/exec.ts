import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { classifyCommand } from 'pi-helper-core';
import { loadHostCatalog, profileFor } from '../hosts.ts';
import { defaultControlDirPath } from '../ssh/config.ts';
import type { RemoteProfile } from '../ssh/profile.ts';
import { runRemoteShell } from '../ssh/shell.ts';
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

      const timeoutSeconds = params.timeoutSeconds ?? 120;
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        return failed(
          ctx.cwd,
          started,
          `timeoutSeconds must be positive (got ${timeoutSeconds})`,
          'SSH_INVALID_TIMEOUT',
        );
      }

      const run = await runRemoteShell(profile, defaultControlDirPath(), {
        command: params.command,
        cwd: params.cwd ?? profile.remoteWorkspace,
        timeoutMs: timeoutSeconds * 1000,
        signal,
      });

      const stdout = clip(run.stdout);
      const stderr = clip(run.stderr);
      const succeeded = run.code === 0 && !run.timedOut && !run.cancelled;
      const data = {
        alias: profile.alias,
        hostname: profile.hostname,
        command: params.command,
        cwd: params.cwd ?? profile.remoteWorkspace,
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
            ? `${profile.alias}: command succeeded (${run.durationMs}ms)`
            : `${profile.alias}: command failed (${sshFailureMessage(run.stderr, run.code, run.timedOut)})`,
          data,
          evidence: [
            { kind: 'ssh-exec', message: `${profile.alias}: ${params.command}` },
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
