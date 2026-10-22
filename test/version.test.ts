import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOOL_VERSION } from '../src/version.ts';

test('the tool version matches package.json, so the envelope never lies', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url).pathname, 'utf8'),
  ) as { version: string };
  assert.equal(TOOL_VERSION, pkg.version);
});
