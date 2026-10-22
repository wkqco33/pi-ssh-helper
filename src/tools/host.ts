import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { describeGaps } from '../ssh/capability.ts';
import { profileFor, loadHostCatalog } from '../hosts.ts';
import { inspectHost, probeHost } from '../ssh/transport.ts';
import type { RemoteProfile } from '../ssh/profile.ts';
import { defaultControlDirPath } from '../ssh/config.ts';
import { HOST_PARAM, clip, failed, result, sshFailureMessage, text } from './common.ts';

function unreachable(
  ctxCwd: string,
  started: number,
  profile: RemoteProfile,
  reason: string,
  detail: unknown,
) {
  return failed(ctxCwd, started, reason, 'SSH_UNREACHABLE', {
    data: detail,
    evidence: [{ kind: 'ssh-host', message: `${profile.alias} (${profile.hostname})` }],
    suggestions: [
      {
        message:
          'Check reachability and key authentication with `ssh -o BatchMode=yes <host> true`.',
        confidence: 'high',
      },
      {
        message:
          'BatchMode=yes is intentional: an interactive password or host-key prompt would hang the tool call.',
        confidence: 'high',
      },
    ],
  });
}

export function registerHostTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'ssh_host_status',
    label: 'SSH Host Status',
    description:
      'Check whether a remote host is reachable over SSH and report what its userland provides (bash, ros2, python3, rsync, ...). Read-only.',
    promptSnippet: 'Check SSH reachability and remote tool availability',
    parameters: Type.Object({ host: HOST_PARAM }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async execute(_id, params, _signal, _update, ctx) {
      const started = Date.now();
      let profile: RemoteProfile;
      try {
        profile = profileFor(await loadHostCatalog(), params.host);
      } catch (error) {
        return failed(ctx.cwd, started, (error as Error).message, 'SSH_CONFIG_INVALID');
      }

      const { result: run, capabilities } = await probeHost(profile, {
        controlDir: defaultControlDirPath(),
      });
      const gaps = describeGaps(capabilities);
      const data = {
        alias: profile.alias,
        hostname: profile.hostname,
        user: profile.user,
        port: profile.port,
        proxyJump: profile.proxyJump,
        remoteWorkspace: profile.remoteWorkspace,
        container: profile.container ?? null,
        containerWorkdir: profile.containerWorkdir ?? null,
        allowMutating: profile.allowMutating,
        reachable: run.code === 0,
        probeMs: run.durationMs,
        capabilities,
      };

      if (run.code !== 0) {
        return unreachable(
          ctx.cwd,
          started,
          profile,
          `cannot reach ${profile.alias}: ${sshFailureMessage(run.stderr, run.code, run.timedOut)}`,
          data,
        );
      }

      return text(
        result(ctx.cwd, started, {
          ok: true,
          summary: `${profile.alias}${profile.container === undefined ? '' : ` (container ${profile.container})`} reachable in ${run.durationMs}ms; ${gaps.length === 0 ? 'no capability gaps' : gaps.length + ' capability gap(s)'}`,
          data,
          evidence: [
            {
              kind: 'ssh-host',
              message: `${profile.alias} → ${profile.hostname}:${profile.port ?? 22}`,
            },
          ],
          warnings: gaps.map((gap) => ({
            code: 'CAPABILITY_GAP',
            message: gap,
            severity: 'warning' as const,
          })),
          errors: [],
          suggestions:
            gaps.length > 0
              ? [
                  {
                    message:
                      'Run ssh_detect_capabilities for versions and installed ROS distributions.',
                    confidence: 'medium',
                  },
                ]
              : [],
          detail: { stderr: clip(run.stderr, 2000).text },
        }),
      );
    },
  });

  pi.registerTool({
    name: 'ssh_detect_capabilities',
    label: 'SSH Detect Capabilities',
    description:
      'Report kernel, bash and python versions, and installed ROS distributions on a remote host. Read-only.',
    promptSnippet: 'Inspect a remote host toolchain before running remote builds',
    parameters: Type.Object({ host: HOST_PARAM }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async execute(_id, params, _signal, _update, ctx) {
      const started = Date.now();
      let profile: RemoteProfile;
      try {
        profile = profileFor(await loadHostCatalog(), params.host);
      } catch (error) {
        return failed(ctx.cwd, started, (error as Error).message, 'SSH_CONFIG_INVALID');
      }

      const { result: run, report } = await inspectHost(profile, {
        controlDir: defaultControlDirPath(),
      });
      if (run.code !== 0) {
        return unreachable(
          ctx.cwd,
          started,
          profile,
          `cannot inspect ${profile.alias}: ${sshFailureMessage(run.stderr, run.code, run.timedOut)}`,
          report,
        );
      }

      const gaps = describeGaps(report.capabilities);
      return text(
        result(ctx.cwd, started, {
          ok: true,
          summary: `${profile.alias}: ${report.kernel || 'unknown kernel'}; ROS ${report.rosDistros.length > 0 ? report.rosDistros.join(', ') : 'not installed'}`,
          data: {
            alias: profile.alias,
            container: profile.container ?? null,
            containerWorkdir: profile.containerWorkdir ?? null,
            ...report,
          },
          evidence: [{ kind: 'ssh-host', message: `${profile.alias} → ${profile.hostname}` }],
          warnings: gaps.map((gap) => ({
            code: 'CAPABILITY_GAP',
            message: gap,
            severity: 'warning' as const,
          })),
          errors: [],
          suggestions:
            report.rosDistros.length === 0
              ? [
                  {
                    message:
                      'ROS is not installed under /opt/ros on the remote host, so remote ROS helper tools cannot run there.',
                    confidence: 'high',
                  },
                ]
              : [],
          detail: { stderr: clip(run.stderr, 2000).text },
        }),
      );
    },
  });
}
