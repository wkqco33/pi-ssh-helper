import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerExecTool } from './exec.ts';
import { registerHostTools } from './host.ts';

export function registerAllTools(pi: ExtensionAPI): void {
  registerHostTools(pi);
  registerExecTool(pi);
}
