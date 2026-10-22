import { createResultFactory, type ResultInput } from 'pi-helper-core';
import { Type } from 'typebox';
import { TOOL_VERSION } from '../version.ts';

/** Shared parameter: every host-aware tool accepts the same alias. */
export const HOST_PARAM = Type.Optional(
  Type.String({
    description:
      'Host alias from ~/.ssh/config or ~/.pi/agent/ssh-helper.json. Defaults to defaultHost in the helper config.',
  }),
);

/** Bound to this package so every tool reports the same version in its envelope. */
export const { result, failure } = createResultFactory(TOOL_VERSION);

/** Model-facing result shape: text for the model, structured details for rendering. */
export const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  details: value,
});

/** A failed envelope, already shaped as a tool result. */
export function failed(
  ctxCwd: string,
  started: number,
  message: string,
  code: string,
  details?: Partial<ResultInput>,
) {
  return text(failure(ctxCwd, started, message, code, details));
}

/** Keeps a remote payload from flooding the model's context. */
export function clip(value: string, limit = 16 * 1024): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, limit)}\n…[clipped ${value.length - limit} characters]`,
    truncated: true,
  };
}

/** One-line stderr summary for a failed ssh invocation. */
export function sshFailureMessage(stderr: string, code: number | null, timedOut: boolean): string {
  if (timedOut) return 'ssh did not complete before the timeout';
  const line = stderr
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .at(-1);
  return line ?? `ssh exited with code ${String(code)} and no message`;
}
