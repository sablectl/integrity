/**
 * `integrity report` — render a verification report.
 *
 * Exists for the case `verify` does not serve: turning a stored JSON report
 * back into something a person can read, long after the run, on a machine
 * that may not have the directory at all. Given no input it performs a
 * verification itself and renders it in full detail.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { booleanOption, stringOption } from '../args.js';
import type { ParsedArgs } from '../args.js';
import type { Command, CommandContext } from '../command.js';
import { GLOBAL_OPTIONS, SCAN_OPTIONS } from '../options.js';
import { COMPARISON_OPTIONS, exitCodeFor, verifyCommand } from './verify.js';
import { UsageError, describeError } from '../../core/errors.js';
import { parseReport, serializeReport } from '../../report/json.js';
import { renderReport } from '../../report/human.js';

export const reportCommand: Command = {
  name: 'report',
  summary: 'Render a verification report, fresh or from a saved file.',
  usage: 'integrity report [directory] [options]',
  description: [
    'With --input, reads a JSON report produced by "integrity verify --json"',
    'and renders it. Use "-" to read from standard input.',
    '',
    'Without --input, runs a verification and renders it with full detail.',
    '',
    'Exit codes match "integrity verify", so a saved report re-rendered in CI',
    'still fails the job it should fail.',
  ],
  options: [
    ...GLOBAL_OPTIONS,
    ...SCAN_OPTIONS,
    ...COMPARISON_OPTIONS,
    {
      name: 'input',
      short: 'i',
      type: 'string',
      placeholder: '<file>',
      description:
        'Render a previously saved JSON report. "-" reads standard input.',
    },
  ],
  examples: [
    'integrity report',
    'integrity report --input report.json',
    'integrity verify --json | integrity report --input -',
  ],

  async run(context: CommandContext, parsed: ParsedArgs) {
    const input = stringOption(parsed, 'input');
    if (input === undefined) {
      // No stored report: produce one. `verify` already owns every option
      // this needs, so it runs that rather than duplicating it.
      return verifyCommand.run(context, withDetail(parsed));
    }

    const text =
      input === '-'
        ? await readStdin()
        : await readFile(resolve(context.cwd, input), 'utf8').catch(
            (error: unknown) => {
              throw new UsageError(
                `Cannot read report ${input}: ${describeError(error)}`,
              );
            },
          );

    const report = parseReport(text, input === '-' ? '<stdin>' : input);

    if (booleanOption(parsed, 'json') === true) {
      context.terminal.out(serializeReport(report).trimEnd());
    } else {
      renderReport(context.terminal, report, {
        detailed: booleanOption(parsed, 'detailed') !== false,
        summaryOnly: booleanOption(parsed, 'summary') === true,
      });
    }
    return exitCodeFor(report);
  },
};

/** Turns on detail unless the caller asked for a summary. */
function withDetail(parsed: ParsedArgs): ParsedArgs {
  const options = new Map(parsed.options);
  if (!options.has('detailed') && !options.has('summary')) {
    options.set('detailed', true);
  }
  return { positionals: parsed.positionals, options };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') {
    throw new UsageError('No report was supplied on standard input.');
  }
  return text;
}
