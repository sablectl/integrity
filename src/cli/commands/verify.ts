/**
 * `integrity verify` — compare the filesystem against a baseline.
 *
 * The exit code is the part scripts depend on, so it is derived from the
 * report rather than from how many lines were printed:
 *
 *   0  everything was checked and nothing changed
 *   1  differences were found
 *   2  nothing changed, but something could not be checked
 *   3  the baseline is missing, malformed, or failed its integrity check
 *
 * There is deliberately no option to update the baseline from here. A
 * verification that can rewrite its own reference state is not a
 * verification.
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { booleanOption, stringOption } from '../args.js';
import type { ParsedArgs } from '../args.js';
import type { Command, CommandContext } from '../command.js';
import { ExitCode } from '../exit-codes.js';
import type { ExitCodeValue } from '../exit-codes.js';
import {
  GLOBAL_OPTIONS,
  SCAN_OPTIONS,
  resolveKey,
  resolveScanSettings,
} from '../options.js';
import { readBaseline } from '../../core/baseline.js';
import { scanDirectory } from '../../core/scan.js';
import { verifySignature } from '../../core/signature.js';
import { compareWithBaseline } from '../../core/verify.js';
import type { VerificationReport } from '../../core/verify.js';
import { CancelledError, IoError, describeError } from '../../core/errors.js';
import { renderReport } from '../../report/human.js';
import { serializeReport } from '../../report/json.js';
import { escapeControlCharacters, formatBytes } from '../../report/format.js';
import { VERSION } from '../../version.js';

/** Options shared by `verify` and `report`. */
export const COMPARISON_OPTIONS = [
  {
    name: 'metadata',
    type: 'boolean' as const,
    negatable: true,
    description: 'Compare permissions and ownership as well as contents.',
  },
  {
    name: 'mtime',
    type: 'boolean' as const,
    negatable: true,
    description:
      'Report modification-time changes on files whose contents match.',
  },
  {
    name: 'json',
    type: 'boolean' as const,
    description: 'Write the report to stdout as JSON.',
  },
  {
    name: 'output',
    short: 'o',
    type: 'string' as const,
    placeholder: '<file>',
    description: 'Also write the JSON report to a file.',
  },
  {
    name: 'detailed',
    type: 'boolean' as const,
    description: 'Include recorded and observed digests for each finding.',
  },
  {
    name: 'summary',
    type: 'boolean' as const,
    description: 'Print only the summary, without per-file findings.',
  },
];

export const verifyCommand: Command = {
  name: 'verify',
  summary: 'Check a directory against its baseline.',
  usage: 'integrity verify [directory] [options]',
  description: [
    'Re-hashes the directory and compares it with the baseline, reporting',
    'modified, added, removed and type-changed entries, and listing anything',
    'that could not be checked.',
    '',
    'Exit codes: 0 clean, 1 changes detected, 2 incomplete, 3 untrusted',
    'baseline, 4 runtime error, 64 invalid usage.',
    '',
    'A run with unreadable files never exits 0, because an unchecked file is',
    'not an unchanged file.',
  ],
  options: [...GLOBAL_OPTIONS, ...SCAN_OPTIONS, ...COMPARISON_OPTIONS],
  examples: [
    'integrity verify',
    'integrity verify /etc --baseline /secure/etc.baseline.json',
    'integrity verify ./app --json > report.json',
    'integrity verify /srv --key-file /media/usb/integrity.key --detailed',
  ],

  async run(context: CommandContext, parsed: ParsedArgs) {
    const settings = await resolveScanSettings(parsed, context.cwd);
    const key = await resolveKey(parsed, context.env, context.cwd);

    const baseline = await readBaseline(settings.baselinePath);
    const signature = verifySignature(baseline, key);

    context.terminal.note(
      `Verifying ${escapeControlCharacters(settings.directory)} against ${escapeControlCharacters(settings.baselinePath)}`,
    );

    let lastReport = 0;
    const scan = await scanDirectory({
      root: settings.directory,
      // The baseline records the options it was built with. Reusing them
      // means a verification cannot disagree with its own baseline about
      // what was in scope, which would otherwise look like real findings.
      exclude: mergeExclusions(baseline.options.exclude, settings.exclude),
      followSymlinks: baseline.options.followSymlinks,
      recordMetadata: baseline.options.recordMetadata,
      oneFileSystem: baseline.options.oneFileSystem,
      maxFileSizeBytes: baseline.options.maxFileSizeBytes,
      maxDepth: baseline.options.maxDepth,
      concurrency: settings.concurrency,
      signal: context.signal,
      onProgress: (progress) => {
        const now = Date.now();
        if (now - lastReport < 100) return;
        lastReport = now;
        context.terminal.progress(
          `  ${String(progress.filesHashed)} files, ${formatBytes(progress.bytesHashed)} — ${escapeControlCharacters(progress.currentPath)}`,
        );
      },
    });
    context.terminal.clearProgress();
    if (context.signal.aborted) throw new CancelledError();

    const report = compareWithBaseline(baseline, scan, {
      checkMetadata: settings.checkMetadata,
      checkMtime: settings.checkMtime,
      baselinePath: settings.baselinePath,
      signature,
      toolVersion: VERSION,
    });

    const asJson = booleanOption(parsed, 'json') === true;
    if (asJson) {
      context.terminal.out(serializeReport(report).trimEnd());
    } else {
      renderReport(context.terminal, report, {
        detailed: booleanOption(parsed, 'detailed') === true,
        summaryOnly: booleanOption(parsed, 'summary') === true,
      });
    }

    const output = stringOption(parsed, 'output');
    if (output !== undefined) {
      const target = resolve(context.cwd, output);
      try {
        await writeFile(target, serializeReport(report), {
          encoding: 'utf8',
          mode: 0o600,
        });
      } catch (error) {
        throw new IoError(
          `Cannot write report ${target}: ${describeError(error)}`,
        );
      }
      context.terminal.note(
        `Report written to ${escapeControlCharacters(target)}`,
      );
    }

    return exitCodeFor(report);
  },
};

/** Maps a verification outcome onto the documented exit codes. */
export function exitCodeFor(report: VerificationReport): ExitCodeValue {
  switch (report.status) {
    case 'baseline-untrusted':
      return ExitCode.BaselineUntrusted;
    case 'changes-detected':
      return ExitCode.ChangesDetected;
    case 'incomplete':
      return ExitCode.Incomplete;
    case 'clean':
      return ExitCode.Ok;
  }
}

/** Combines the baseline's recorded exclusions with any added on the CLI. */
export function mergeExclusions(
  recorded: readonly string[],
  requested: readonly string[],
): readonly string[] {
  const merged = [...recorded];
  for (const pattern of requested) {
    if (!merged.includes(pattern)) merged.push(pattern);
  }
  return merged;
}
