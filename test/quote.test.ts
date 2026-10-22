import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { shJoin, shQuote } from '../src/ssh/quote.ts';

/**
 * Quoting is checked by running the result, not by comparing strings: a
 * comparison would agree with any consistently wrong implementation.
 */
function roundTrip(value: string): string {
  return execFileSync('sh', ['-c', `printf '%s' ${shQuote(value)}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

const VALUES = [
  'plain',
  'with space',
  "it's",
  '$(whoami)',
  '`id`',
  'a\nb',
  '한글 경로',
  '--leading-dash',
  '; rm -rf /',
  '',
  '\\backslash',
  '"double"',
  '*glob?',
];

test('every value survives one shell round trip unchanged', () => {
  for (const value of VALUES) {
    assert.equal(roundTrip(value), value, `round trip failed for ${JSON.stringify(value)}`);
  }
});

test('a command substitution is data, not executed', () => {
  const output = execFileSync(
    'sh',
    ['-c', `printf '%s' ${shQuote('$(touch /tmp/pi-ssh-should-not-exist)')}`],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(output, '$(touch /tmp/pi-ssh-should-not-exist)');
});

test('an argument vector is quoted element by element', () => {
  const quoted = shJoin(['echo', 'two words', "it's"]);
  const output = execFileSync('sh', ['-c', quoted], { encoding: 'utf8' });
  assert.equal(output, "two words it's\n");
});

test('an empty vector produces an empty string rather than a stray quote', () => {
  assert.equal(shJoin([]), '');
});
