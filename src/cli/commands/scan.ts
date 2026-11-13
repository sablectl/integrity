/**
 * `integrity scan` — record the trusted reference state.
 *
 * Writing a baseline is the one operation that defines what "unchanged"
 * means afterwards, so it refuses to replace an existing baseline unless
 * asked explicitly. An integrity tool that re-baselines on its own can
 * always be made to bless whatever it finds.
 */
import { relative } from 'node:path';
import { booleanOption, stringOption } from '../args.js';
import type { ParsedArgs } from '../args.js';
import type { Command, CommandContext } from '../command.js';
import { ExitCode } from '../exit-codes.js';
import {
  GLOBAL_OPTIONS,
  SCAN_OPTIONS,
  resolveKey,
  resolveScanSettings,
} from '../options.js';
import { buildBaseline, writeBaseline } from '../../core/baseline.js';
import { scanDirectory } from '../../core/scan.js';
import { signBaseline } from '../../core/signature.js';
import { CancelledError } from '../../core/errors.js';
import { VERSION } from '../../version.js';
import {
  escapeControlCharacters,
  formatBytes,
  formatDuration,
  plural,
} from '../../report/format.js';

export const scanCommand: Command = {
  name: 'scan',
  summary: 'Record a cryptographic baseline of a directory.',
  usage: 'integrity scan [directory] [options]',
  description: [
    'Walks the directory, hashes every regular file with SHA-256, and writes',
    'a baseline describing the state you are choosing to trust.',
    '',
    'Run this only when you believe the directory is in a known-good state.',
    'An existing baseline is never replaced without --force.',
    '',
    'Pass --key-file to add an HMAC-SHA-256 tag over the baseline. Without a',
    'key the baseline detects accidental and unprivileged change, but not an',
    'attacker who can rewrite both the files and the baseline.',
  ],
  options: [
    ...GLOBAL_OPTIONS,
    ...SCAN_OPTIONS,
    {
      name: 'force',
      short: 'f',
      type: 'boolean',
      description: 'Replace an existing baseline. Always an explicit choice.',
    },
    {
      name: 'stdout',
      type: 'boolean',
      description: 'Write the baseline to stdout instead of to a file.',
    },
  ],
  examples: [
    'integrity scan',
    'integrity scan /etc --baseline /secure/etc.baseline.json',
    'integrity scan ./app --exclude "node_modules/" --exclude "*.log"',
    'integrity scan /srv --key-file /media/usb/integrity.key --key-id prod-2025',
  ],

  async run(context: CommandContext, parsed: ParsedArgs) {
    const settings = await resolveScanSettings(parsed, context.cwd);
    const key = await resolveKey(parsed, context.env, context.cwd);
    const toStdout = booleanOption(parsed, 'stdout') === true;

    context.terminal.note(
      `Scanning ${escapeControlCharacters(settings.directory)}`,
    );

    let lastReport = 0;
    const scan = await scanDirectory({
      root: settings.directory,
      exclude: settings.exclude,
      followSymlinks: settings.followSymlinks,
      recordMetadata: settings.recordMetadata,
      oneFileSystem: settings.oneFileSystem,
      maxFileSizeBytes: settings.maxFileSizeBytes,
      maxDepth: settings.maxDepth,
      concurrency: settings.concurrency,
      signal: context.signal,
      onProgress: (progress) => {
        // Redrawing on every file wastes more time than it informs.
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

    const unsigned = buildBaseline(scan, VERSION);
    const baseline = key ? signBaseline(unsigned, key) : unsigned;

    if (toStdout) {
      context.terminal.out(JSON.stringify(baseline, null, 2));
    } else {
      await writeBaseline(settings.baselinePath, baseline, {
        overwrite: booleanOption(parsed, 'force') === true,
      });
      const shown =
        relative(context.cwd, settings.baselinePath) || settings.baselinePath;
      context.terminal.out(
        `Baseline written to ${escapeControlCharacters(shown)}`,
      );
    }

    context.terminal.note(
      `  ${plural(scan.stats.files, 'file')}, ${plural(scan.stats.symlinks, 'symlink')}, ${formatBytes(scan.stats.totalBytes)} hashed in ${formatDuration(scan.durationMs)}`,
    );
    if (scan.skipped.length > 0) {
      context.terminal.note(
        `  ${plural(scan.skipped.length, 'entry', 'entries')} could not be recorded and are listed in the baseline.`,
      );
      for (const skip of scan.skipped.slice(0, 10)) {
        context.terminal.note(
          `    ${escapeControlCharacters(skip.path)} — ${escapeControlCharacters(skip.message)}`,
        );
      }
      if (scan.skipped.length > 10) {
        context.terminal.note(
          `    ... and ${String(scan.skipped.length - 10)} more.`,
        );
      }
    }
    if (!key) {
      context.terminal.note('');
      context.terminal.note(
        '  This baseline is unsigned. Store it where an attacker who can modify',
      );
      context.terminal.note(
        '  the monitored files cannot modify it, or sign it with --key-file.',
      );
    } else if (stringOption(parsed, 'key-file') !== undefined) {
      context.terminal.note(`  Signed using ${key.origin}.`);
    }

    return ExitCode.Ok;
  },
};
