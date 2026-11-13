/**
 * `integrity watch` — monitor a directory continuously.
 *
 * Prints a line per event, or one JSON object per line with `--json` so the
 * output can be piped straight into a log pipeline. Ctrl-C stops it cleanly
 * and prints a session summary.
 *
 * The documented limits are repeated in the startup banner rather than
 * buried in a manual: filesystem watchers miss events, and an operator who
 * believes otherwise is worse off than one using no tool at all.
 */
import { booleanOption, integerOption } from '../args.js';
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
import { COMPARISON_OPTIONS, mergeExclusions } from './verify.js';
import { readBaseline } from '../../core/baseline.js';
import { verifySignature } from '../../core/signature.js';
import { watchDirectory } from '../../core/watch.js';
import type { WatchEvent } from '../../core/watch.js';
import { toNdjsonLine } from '../../report/json.js';
import { escapeControlCharacters, plural } from '../../report/format.js';
import { VERSION } from '../../version.js';

export const watchCommand: Command = {
  name: 'watch',
  summary: 'Monitor a directory and verify it as it changes.',
  usage: 'integrity watch [directory] [options]',
  description: [
    'Verifies the directory once, then watches it. Filesystem events are',
    'debounced and trigger a verification; a full verification also runs on a',
    'timer, which is what makes the result trustworthy.',
    '',
    'Limits worth knowing: filesystem watchers coalesce and drop events under',
    'load, cannot see changes made while this process was not running, and',
    'are not uniform across platforms. The periodic verification, not the',
    'watcher, is the authoritative check.',
    '',
    'Stops cleanly on Ctrl-C and prints a session summary.',
  ],
  options: [
    ...GLOBAL_OPTIONS,
    ...SCAN_OPTIONS,
    ...COMPARISON_OPTIONS.filter((option) => option.name !== 'output'),
    {
      name: 'debounce',
      type: 'number',
      placeholder: '<ms>',
      description:
        'Quiet period before a batch of events triggers a check. Default 250.',
    },
    {
      name: 'interval',
      type: 'number',
      placeholder: '<seconds>',
      description:
        'Gap between full verifications. 0 disables them. Default 300.',
    },
    {
      name: 'max-pending',
      type: 'number',
      placeholder: '<n>',
      description:
        'Largest number of paths buffered between checks. Default 5000.',
    },
    {
      name: 'once',
      type: 'boolean',
      description:
        'Verify once and exit. Useful for testing the configuration.',
    },
  ],
  examples: [
    'integrity watch',
    'integrity watch /etc --interval 60',
    'integrity watch ./app --json | tee integrity.ndjson',
  ],

  async run(context: CommandContext, parsed: ParsedArgs) {
    const settings = await resolveScanSettings(parsed, context.cwd);
    const key = await resolveKey(parsed, context.env, context.cwd);
    const baseline = await readBaseline(settings.baselinePath);
    const signature = verifySignature(baseline, key);
    const asJson = booleanOption(parsed, 'json') === true;
    const once = booleanOption(parsed, 'once') === true;
    const maxPending = integerOption(parsed, 'max-pending', {
      min: 1,
      max: 1_000_000,
    });
    const terminal = context.terminal;

    let worstExit: ExitCodeValue = ExitCode.Ok;
    const controller = new AbortController();
    const stop = (): void => {
      controller.abort();
    };
    context.signal.addEventListener('abort', stop, { once: true });

    const emit = (event: WatchEvent): void => {
      if (asJson) {
        terminal.out(toNdjsonLine(toJsonEvent(event)).trimEnd());
      } else {
        renderEvent(event);
      }
      if (event.type === 'verification') {
        const code = severityExit(event.report.status);
        if (code > worstExit) worstExit = code;
        if (once) controller.abort();
      }
    };

    const renderEvent = (event: WatchEvent): void => {
      const stamp = terminal.style(new Date().toISOString(), 'dim');
      switch (event.type) {
        case 'started':
          terminal.out(
            `${stamp} watching ${escapeControlCharacters(event.root)}${event.recursive ? '' : ' (top level only)'}`,
          );
          break;
        case 'activity':
          terminal.out(
            `${stamp} ${plural(event.paths.length, 'path')} changed${event.truncated ? ' (more than the buffer could hold)' : ''}`,
          );
          break;
        case 'verification': {
          const { report } = event;
          const label =
            report.status === 'clean'
              ? terminal.style('clean', 'green')
              : report.status === 'changes-detected'
                ? terminal.style('CHANGES', 'red')
                : report.status === 'incomplete'
                  ? terminal.style('INCOMPLETE', 'yellow')
                  : terminal.style('BASELINE UNTRUSTED', 'magenta');
          terminal.out(
            `${stamp} ${event.trigger} check: ${label} — ${String(report.summary.modified)} modified, ${String(report.summary.added)} added, ${String(report.summary.removed)} removed, ${String(report.summary.unreadable)} unchecked`,
          );
          break;
        }
        case 'findings':
          for (const finding of event.findings) {
            terminal.out(
              `${stamp}   ${finding.severity.toUpperCase().padEnd(8)} ${finding.change.padEnd(12)} ${escapeControlCharacters(finding.path)}`,
            );
          }
          break;
        case 'warning':
          terminal.err(
            `${stamp} ${terminal.style('warning', 'yellow')} ${event.message}`,
          );
          break;
        case 'stopped':
          terminal.out(`${stamp} stopped`);
          break;
      }
    };

    const summary = await watchDirectory({
      baseline,
      scan: {
        root: settings.directory,
        // Same rule as `verify`: the baseline's recorded scope is
        // authoritative, and anything added on the command line narrows it
        // further. The two commands must not disagree about what is in
        // scope, or watch mode would report drift that verify does not.
        exclude: mergeExclusions(baseline.options.exclude, settings.exclude),
        followSymlinks: baseline.options.followSymlinks,
        recordMetadata: baseline.options.recordMetadata,
        oneFileSystem: baseline.options.oneFileSystem,
        maxFileSizeBytes: baseline.options.maxFileSizeBytes,
        maxDepth: baseline.options.maxDepth,
        concurrency: settings.concurrency,
      },
      compare: {
        checkMetadata: settings.checkMetadata,
        checkMtime: settings.checkMtime,
        baselinePath: settings.baselinePath,
        signature,
        toolVersion: VERSION,
      },
      debounceMs: settings.debounceMs,
      intervalSeconds: once ? 0 : settings.intervalSeconds,
      ...(maxPending === undefined ? {} : { maxPendingPaths: maxPending }),
      signal: controller.signal,
      onEvent: emit,
    });

    context.signal.removeEventListener('abort', stop);

    if (!asJson) {
      terminal.note(
        `  ${plural(summary.verifications, 'verification')}, ${plural(summary.findingsSeen, 'finding')} reported.`,
      );
    }
    return worstExit;
  },
};

function severityExit(status: string): ExitCodeValue {
  switch (status) {
    case 'baseline-untrusted':
      return ExitCode.BaselineUntrusted;
    case 'changes-detected':
      return ExitCode.ChangesDetected;
    case 'incomplete':
      return ExitCode.Incomplete;
    default:
      return ExitCode.Ok;
  }
}

/** Flattens an event into a stable JSON record for log pipelines. */
function toJsonEvent(event: WatchEvent): unknown {
  const timestamp = new Date().toISOString();
  switch (event.type) {
    case 'verification':
      return {
        timestamp,
        event: 'verification',
        trigger: event.trigger,
        status: event.report.status,
        complete: event.report.complete,
        summary: event.report.summary,
      };
    case 'findings':
      return { timestamp, event: 'findings', findings: event.findings };
    case 'activity':
      return {
        timestamp,
        event: 'activity',
        paths: event.paths,
        truncated: event.truncated,
      };
    case 'started':
      return {
        timestamp,
        event: 'started',
        root: event.root,
        recursive: event.recursive,
      };
    case 'warning':
      return { timestamp, event: 'warning', message: event.message };
    case 'stopped':
      return { timestamp, event: 'stopped', reason: event.reason };
  }
}
