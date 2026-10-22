/**
 * A remote command is a shell string, so every value that reaches it must be
 * quoted for `sh` rather than concatenated. Unquoted paths break on spaces, and
 * an unquoted `$(...)` would execute on the remote host instead of being passed
 * through as data.
 */

/** Quotes one value for POSIX `sh`, including its surrounding quotes. */
export function shQuote(value: string): string {
  if (value === '') return "''";
  // Single quotes protect everything except a single quote, which is closed,
  // escaped, and reopened: it's -> 'it'\''s'
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quotes every element of an argument vector and joins it with spaces. */
export function shJoin(argv: readonly string[]): string {
  return argv.map(shQuote).join(' ');
}
