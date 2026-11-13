/**
 * `integrity init` — write a configuration file for a directory.
 *
 * Deliberately does not create a baseline. Establishing the trusted
 * reference state is a decision an operator makes about a directory they
 * believe is clean, and bundling it into a scaffolding command would make
 * it something that happens by accident.
 */
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { booleanOption } from '../args.js';
import type { ParsedArgs } from '../args.js';
import type { Command, CommandContext } from '../command.js';
import { ExitCode } from '../exit-codes.js';
import { GLOBAL_OPTIONS } from '../options.js';
import {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  serializeConfig,
} from '../../core/config.js';
import {
  IoError,
  UsageError,
  describeError,
  errorCode,
} from '../../core/errors.js';
import { escapeControlCharacters } from '../../report/format.js';

export const initCommand: Command = {
  name: 'init',
  summary: 'Write a configuration file for a directory.',
  usage: 'integrity init [directory] [options]',
  description: [
    'Creates integrity.config.json with the default exclusions and limits so',
    'that scan, verify and watch all agree about what is being protected.',
    '',
    'No baseline is created. Run "integrity scan" once the directory is in a',
    'state you are prepared to trust.',
  ],
  options: [
    ...GLOBAL_OPTIONS,
    {
      name: 'force',
      short: 'f',
      type: 'boolean',
      description: 'Overwrite an existing configuration file.',
    },
    {
      name: 'print',
      type: 'boolean',
      description: 'Write the configuration to stdout instead of to a file.',
    },
  ],
  examples: [
    'integrity init',
    'integrity init /etc --print',
    'integrity init ./release --force',
  ],

  async run(context: CommandContext, parsed: ParsedArgs) {
    if (parsed.positionals.length > 1) {
      throw new UsageError('Expected at most one directory.');
    }
    const directory = resolve(context.cwd, parsed.positionals[0] ?? '.');
    const body = serializeConfig(DEFAULT_CONFIG);

    if (booleanOption(parsed, 'print') === true) {
      context.terminal.out(body.trimEnd());
      return ExitCode.Ok;
    }

    const target = join(directory, CONFIG_FILE_NAME);
    const force = booleanOption(parsed, 'force') === true;
    const flags = force
      ? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC
      : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;

    try {
      const handle = await open(target, flags, 0o644);
      try {
        await handle.writeFile(body, 'utf8');
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        throw new IoError(`${target} already exists.`, [
          'Pass --force to replace it.',
        ]);
      }
      throw new IoError(`Cannot write ${target}: ${describeError(error)}`);
    }

    const shown = relative(context.cwd, target) || target;
    context.terminal.out(`Wrote ${escapeControlCharacters(shown)}`);
    context.terminal.note('');
    context.terminal.note(
      'Next: review the exclusions, then record the trusted state with',
    );
    context.terminal.note(
      `  integrity scan ${escapeControlCharacters(parsed.positionals[0] ?? '.')}`,
    );
    return ExitCode.Ok;
  },
};
