/**
 * Exclusion patterns.
 *
 * A deliberately small glob dialect, implemented here rather than pulled in
 * as a dependency: the matcher is the thing that decides which files are
 * *not* protected, so its behaviour has to be obvious and fully covered by
 * tests rather than inherited from a general-purpose library.
 *
 * Supported syntax, matched against the path relative to the scan root and
 * always written with `/` separators:
 *
 * - `*`     matches any run of characters except `/`
 * - `?`     matches exactly one character except `/`
 * - `**`    matches any run of characters including `/`
 * - `[abc]` matches one character from the set; `[!abc]` negates it
 * - a trailing `/` restricts the pattern to directories
 * - a pattern containing no `/` (other than a trailing one) matches that
 *   name at any depth, the way `.gitignore` behaves
 * - a leading `/` anchors the pattern to the scan root
 *
 * Patterns never match outside the scan root, and `..` in a pattern is
 * rejected outright: an exclusion list is configuration, not a path.
 */
import { UsageError } from './errors.js';

export interface CompiledPattern {
  readonly source: string;
  readonly directoryOnly: boolean;
  readonly regex: RegExp;
}

export class ExcludeMatcher {
  private readonly patterns: readonly CompiledPattern[];

  constructor(patterns: readonly string[]) {
    this.patterns = patterns.map(compilePattern);
  }

  /** The patterns this matcher was built from, in their original form. */
  get sources(): readonly string[] {
    return this.patterns.map((pattern) => pattern.source);
  }

  get isEmpty(): boolean {
    return this.patterns.length === 0;
  }

  /**
   * Tests a path relative to the scan root. `isDirectory` decides whether
   * directory-only patterns apply.
   */
  matches(relativePath: string, isDirectory: boolean): boolean {
    if (relativePath === '') return false;
    for (const pattern of this.patterns) {
      if (pattern.directoryOnly && !isDirectory) continue;
      if (pattern.regex.test(relativePath)) return true;
    }
    return false;
  }
}

/** Compiles one pattern into an anchored regular expression. */
export function compilePattern(pattern: string): CompiledPattern {
  const source = pattern.trim();
  if (source === '') {
    throw new UsageError('Exclusion pattern must not be empty.');
  }
  if (source.split('/').includes('..')) {
    throw new UsageError(`Exclusion pattern must not contain "..": ${source}`, [
      'Patterns are matched against paths relative to the scan root.',
    ]);
  }

  const directoryOnly = source.endsWith('/');
  let body = directoryOnly ? source.slice(0, -1) : source;
  if (body === '') {
    throw new UsageError(`Exclusion pattern must name something: ${source}`);
  }

  const anchored = body.startsWith('/');
  if (anchored) body = body.slice(1);

  // A bare name matches at any depth; anything with a separator is a path.
  const floating = !anchored && !body.includes('/');
  const expression = floating
    ? `(?:^|.*/)${translate(body)}(?:/.*)?$`
    : `^${translate(body)}(?:/.*)?$`;

  return {
    source,
    directoryOnly,
    regex: new RegExp(expression),
  };
}

/** Translates the glob dialect into a regular expression fragment. */
function translate(pattern: string): string {
  let out = '';
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === '*') {
      const isDoubleStar = pattern[index + 1] === '*';
      if (isDoubleStar) {
        // `a/**/b` must also match `a/b`, so the separator is absorbed.
        if (pattern[index + 2] === '/') {
          out += '(?:.*/)?';
          index += 3;
          continue;
        }
        out += '.*';
        index += 2;
        continue;
      }
      out += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      index += 1;
      continue;
    }
    if (char === '[') {
      const end = findClassEnd(pattern, index);
      if (end === -1) {
        out += '\\[';
        index += 1;
        continue;
      }
      let body = pattern.slice(index + 1, end);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      out += `[${body.replace(/\\/g, '\\\\')}]`;
      index = end + 1;
      continue;
    }
    out += escapeLiteral(char ?? '');
    index += 1;
  }
  return out;
}

function findClassEnd(pattern: string, start: number): number {
  for (let index = start + 1; index < pattern.length; index += 1) {
    if (pattern[index] === ']' && index > start + 1) return index;
  }
  return -1;
}

function escapeLiteral(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}
