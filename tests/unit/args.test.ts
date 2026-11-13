import { describe, expect, it } from 'vitest';
import {
  booleanOption,
  integerOption,
  listOption,
  parseArgs,
  parseSize,
  stringOption,
} from '../../src/cli/args.js';
import type { OptionSpec } from '../../src/cli/args.js';
import { UsageError } from '../../src/core/errors.js';

const specs: readonly OptionSpec[] = [
  { name: 'quiet', short: 'q', type: 'boolean', description: 'quiet' },
  { name: 'color', type: 'boolean', negatable: true, description: 'colour' },
  { name: 'baseline', short: 'b', type: 'string', description: 'baseline' },
  { name: 'exclude', short: 'e', type: 'string[]', description: 'exclude' },
  {
    name: 'concurrency',
    short: 'j',
    type: 'number',
    description: 'concurrency',
  },
];

describe('argument parsing', () => {
  it('collects positionals', () => {
    const parsed = parseArgs(['./app'], specs);
    expect(parsed.positionals).toEqual(['./app']);
  });

  it('accepts a value as a separate argument or after an equals sign', () => {
    expect(
      stringOption(parseArgs(['--baseline', 'b.json'], specs), 'baseline'),
    ).toBe('b.json');
    expect(
      stringOption(parseArgs(['--baseline=b.json'], specs), 'baseline'),
    ).toBe('b.json');
  });

  it('resolves short options', () => {
    const parsed = parseArgs(['-q', '-b', 'b.json'], specs);
    expect(booleanOption(parsed, 'quiet')).toBe(true);
    expect(stringOption(parsed, 'baseline')).toBe('b.json');
  });

  it('accumulates repeated list options', () => {
    const parsed = parseArgs(['-e', '*.log', '--exclude', 'cache/'], specs);
    expect(listOption(parsed, 'exclude')).toEqual(['*.log', 'cache/']);
  });

  it('supports --no- prefixes on negatable flags only', () => {
    expect(booleanOption(parseArgs(['--no-color'], specs), 'color')).toBe(
      false,
    );
    expect(() => parseArgs(['--no-quiet'], specs)).toThrow(UsageError);
  });

  it('stops option parsing after --', () => {
    const parsed = parseArgs(['--', '--not-an-option'], specs);
    expect(parsed.positionals).toEqual(['--not-an-option']);
  });

  it('rejects an unknown option rather than ignoring it', () => {
    expect(() => parseArgs(['--exlude', '*.log'], specs)).toThrow(UsageError);
    expect(() => parseArgs(['-z'], specs)).toThrow(UsageError);
    expect(() => parseArgs(['-qb'], specs)).toThrow(UsageError);
  });

  it('rejects a missing value', () => {
    expect(() => parseArgs(['--baseline'], specs)).toThrow(/requires a value/);
    expect(() => parseArgs(['--baseline', '--quiet'], specs)).toThrow(
      /requires a value/,
    );
  });

  it('rejects a value given to a boolean flag', () => {
    expect(() => parseArgs(['--quiet=yes'], specs)).toThrow(
      /does not take a value/,
    );
  });

  it('rejects a non-numeric value for a numeric option', () => {
    expect(() => parseArgs(['--concurrency', 'many'], specs)).toThrow(
      /requires a number/,
    );
  });

  it('enforces integer bounds', () => {
    const parsed = parseArgs(['--concurrency', '4'], specs);
    expect(integerOption(parsed, 'concurrency', { min: 1, max: 16 })).toBe(4);
    expect(() =>
      integerOption(parseArgs(['-j', '0'], specs), 'concurrency', {
        min: 1,
        max: 16,
      }),
    ).toThrow(/must be between/);
    expect(() =>
      integerOption(parseArgs(['-j', '1.5'], specs), 'concurrency'),
    ).toThrow(/whole number/);
  });
});

describe('size parsing', () => {
  it('reads plain byte counts and suffixes', () => {
    expect(parseSize('1024', 'max-file-size')).toBe(1024);
    expect(parseSize('1K', 'max-file-size')).toBe(1024);
    expect(parseSize('20M', 'max-file-size')).toBe(20 * 1024 * 1024);
    expect(parseSize('2G', 'max-file-size')).toBe(2 * 1024 ** 3);
  });

  it('accepts "off" as no limit', () => {
    expect(parseSize('off', 'max-file-size')).toBeNull();
  });

  it('rejects nonsense', () => {
    expect(() => parseSize('big', 'max-file-size')).toThrow(UsageError);
    expect(() => parseSize('-5M', 'max-file-size')).toThrow(UsageError);
  });
});
