import { describe, expect, it } from 'vitest';
import { ExcludeMatcher, compilePattern } from '../../src/core/exclude.js';
import { UsageError } from '../../src/core/errors.js';

function matches(pattern: string, path: string, isDirectory = false): boolean {
  return new ExcludeMatcher([pattern]).matches(path, isDirectory);
}

describe('exclusion patterns', () => {
  it('matches a bare name at any depth, like .gitignore', () => {
    expect(matches('node_modules', 'node_modules')).toBe(true);
    expect(matches('node_modules', 'app/node_modules')).toBe(true);
    expect(matches('node_modules', 'app/node_modules/pkg/index.js')).toBe(true);
    expect(matches('node_modules', 'app/not_node_modules')).toBe(false);
  });

  it('anchors a pattern that begins with a slash', () => {
    expect(matches('/build', 'build')).toBe(true);
    expect(matches('/build', 'build/output.js')).toBe(true);
    expect(matches('/build', 'app/build')).toBe(false);
  });

  it('applies a trailing slash only to directories', () => {
    expect(matches('cache/', 'cache', true)).toBe(true);
    expect(matches('cache/', 'cache', false)).toBe(false);
  });

  it('expands * without crossing a separator', () => {
    expect(matches('*.log', 'server.log')).toBe(true);
    expect(matches('*.log', 'logs/server.log')).toBe(true);
    expect(matches('/*.log', 'logs/server.log')).toBe(false);
  });

  it('expands ** across separators', () => {
    expect(matches('src/**/*.map', 'src/a/b/c.map')).toBe(true);
    expect(matches('src/**/*.map', 'src/c.map')).toBe(true);
    expect(matches('src/**/*.map', 'lib/c.map')).toBe(false);
  });

  it('matches a single character with ?', () => {
    expect(matches('/log?.txt', 'log1.txt')).toBe(true);
    expect(matches('/log?.txt', 'log12.txt')).toBe(false);
  });

  it('supports character classes and negation', () => {
    expect(matches('/log[0-9].txt', 'log7.txt')).toBe(true);
    expect(matches('/log[!0-9].txt', 'log7.txt')).toBe(false);
    expect(matches('/log[!0-9].txt', 'logx.txt')).toBe(true);
  });

  it('treats regular-expression metacharacters as literals', () => {
    expect(matches('/a+b.txt', 'a+b.txt')).toBe(true);
    expect(matches('/a+b.txt', 'aab.txt')).toBe(false);
    expect(matches('/file.txt', 'fileXtxt')).toBe(false);
  });

  it('handles unicode names', () => {
    expect(matches('/документы/', 'документы', true)).toBe(true);
    expect(matches('*.日本語', 'メモ.日本語')).toBe(true);
  });

  it('never matches the root itself', () => {
    expect(new ExcludeMatcher(['**']).matches('', true)).toBe(false);
  });

  it('rejects patterns containing ".."', () => {
    expect(() => compilePattern('../escape')).toThrow(UsageError);
    expect(() => compilePattern('a/../b')).toThrow(UsageError);
  });

  it('rejects an empty pattern', () => {
    expect(() => compilePattern('   ')).toThrow(UsageError);
    expect(() => compilePattern('/')).toThrow(UsageError);
  });

  it('reports an empty matcher as empty', () => {
    const matcher = new ExcludeMatcher([]);
    expect(matcher.isEmpty).toBe(true);
    expect(matcher.matches('anything', false)).toBe(false);
  });

  it('keeps the original pattern text for the baseline record', () => {
    expect(new ExcludeMatcher([' *.log ', 'cache/']).sources).toEqual([
      '*.log',
      'cache/',
    ]);
  });
});
