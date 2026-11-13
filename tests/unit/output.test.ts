import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import {
  escapeControlCharacters,
  formatBytes,
  formatDuration,
  plural,
} from '../../src/report/format.js';
import { Terminal, shouldUseColor } from '../../src/cli/terminal.js';
import {
  parseConfig,
  serializeConfig,
  DEFAULT_CONFIG,
} from '../../src/core/config.js';
import { UsageError } from '../../src/core/errors.js';
import { parseReport, serializeReport } from '../../src/report/json.js';
import type { VerificationReport } from '../../src/core/verify.js';

class Sink extends Writable {
  text = '';
  isTTY = false;
  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: () => void,
  ): void {
    this.text += String(chunk);
    callback();
  }
}

describe('filename escaping', () => {
  it('neutralises terminal escape sequences in filenames', () => {
    const hostile = 'evil\u001B[2K\rAll files verified.txt';

    const escaped = escapeControlCharacters(hostile);

    expect(escaped).not.toContain('\u001B');
    expect(escaped).not.toContain('\r');
    expect(escaped).toContain('\\x1b');
  });

  it('escapes bidirectional overrides used to disguise extensions', () => {
    expect(escapeControlCharacters('invoice\u202Egnp.exe')).toContain(
      '\\u202e',
    );
  });

  it('leaves ordinary unicode filenames readable', () => {
    expect(escapeControlCharacters('日本語 — ümlaut.txt')).toBe(
      '日本語 — ümlaut.txt',
    );
  });
});

describe('human-readable quantities', () => {
  it('formats byte counts', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(1024 * 1024 * 5)).toBe('5.0 MiB');
  });

  it('formats durations', () => {
    expect(formatDuration(12)).toBe('12 ms');
    expect(formatDuration(1500)).toBe('1.5 s');
    expect(formatDuration(65_000)).toBe('1 m 5 s');
  });

  it('pluralises counts', () => {
    expect(plural(1, 'file')).toBe('1 file');
    expect(plural(2, 'file')).toBe('2 files');
    expect(plural(2, 'entry', 'entries')).toBe('2 entries');
  });
});

describe('colour decisions', () => {
  it('honours NO_COLOR whatever the terminal is', () => {
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: '' }, undefined)).toBe(
      false,
    );
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: '1' }, undefined)).toBe(
      false,
    );
  });

  it('disables colour when output is not a terminal', () => {
    expect(shouldUseColor({ isTTY: false }, {}, undefined)).toBe(false);
    expect(shouldUseColor({}, {}, undefined)).toBe(false);
  });

  it('disables colour for dumb terminals', () => {
    expect(shouldUseColor({ isTTY: true }, { TERM: 'dumb' }, undefined)).toBe(
      false,
    );
  });

  it('lets an explicit choice win', () => {
    expect(shouldUseColor({ isTTY: false }, { NO_COLOR: '1' }, true)).toBe(
      true,
    );
    expect(shouldUseColor({ isTTY: true }, {}, false)).toBe(false);
  });

  it('emits no escape sequences when colour is off', () => {
    const stdout = new Sink();
    const stderr = new Sink();
    const terminal = new Terminal({
      streams: { stdout, stderr },
      env: { NO_COLOR: '1' },
    });

    terminal.out(terminal.style('important', 'red', 'bold'));

    expect(stdout.text).toBe('important\n');
  });

  it('writes no progress to a non-interactive stderr', () => {
    const stdout = new Sink();
    const stderr = new Sink();
    const terminal = new Terminal({ streams: { stdout, stderr }, env: {} });

    terminal.progress('hashing something');

    expect(stderr.text).toBe('');
  });
});

/** Asserts that configuration validation reports a particular problem. */
function expectConfigProblem(text: string, pattern: RegExp): void {
  try {
    parseConfig(text);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).details.join('\n')).toMatch(pattern);
    return;
  }
  throw new Error('Expected the configuration to be rejected.');
}

describe('configuration files', () => {
  it('round-trips the default configuration', () => {
    expect(parseConfig(serializeConfig(DEFAULT_CONFIG))).toEqual(
      DEFAULT_CONFIG,
    );
  });

  it('rejects an unknown key rather than ignoring it', () => {
    expectConfigProblem('{"excludes": []}', /Unknown option: excludes/);
  });

  it('rejects wrongly typed values', () => {
    expect(() => parseConfig('{"exclude": "*.log"}')).toThrow(UsageError);
    expect(() => parseConfig('{"followSymlinks": "yes"}')).toThrow(UsageError);
    expect(() => parseConfig('{"concurrency": -1}')).toThrow(UsageError);
  });

  it('rejects an invalid exclusion pattern', () => {
    expectConfigProblem('{"exclude": ["../escape"]}', /\.\./);
  });

  it('accepts null as "no limit"', () => {
    expect(
      parseConfig('{"maxFileSizeBytes": null}').maxFileSizeBytes,
    ).toBeNull();
  });

  it('rejects malformed JSON and non-objects', () => {
    expect(() => parseConfig('{')).toThrow(UsageError);
    expect(() => parseConfig('[]')).toThrow(UsageError);
  });
});

describe('report serialization', () => {
  const report = {
    tool: { name: 'integrity', version: '1.0.0' },
    generatedAt: '2025-11-13T00:00:00.000Z',
    root: '/tmp/example',
    baselineCreatedAt: '2025-11-13T00:00:00.000Z',
    signature: { status: 'unsigned' as const },
    status: 'clean' as const,
    complete: true,
    summary: {
      checked: 0,
      unchanged: 0,
      added: 0,
      removed: 0,
      modified: 0,
      typeChanged: 0,
      metadataChanged: 0,
      unreadable: 0,
      skipped: 0,
    },
    findings: [],
    skipped: [],
    durationMs: 1,
  } satisfies VerificationReport;

  it('round-trips a report', () => {
    expect(parseReport(serializeReport(report))).toEqual(report);
  });

  it('refuses something that is not a report', () => {
    expect(() => parseReport('{"hello": "world"}')).toThrow(
      /missing the "status"/,
    );
    expect(() => parseReport('not json')).toThrow(UsageError);
  });
});
