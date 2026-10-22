import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerRemoteCommand } from '../src/commands/remote.ts';
import { registerAllTools } from '../src/tools/index.ts';

/**
 * The only file that knows about pi. Everything it calls is testable on its own,
 * because the interesting failures here (quoting, path mapping, config typos) are
 * not pi failures.
 */
export default function (pi: ExtensionAPI): void {
  registerAllTools(pi);
  registerRemoteCommand(pi);
}
