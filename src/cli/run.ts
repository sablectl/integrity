/**
 * The command dispatcher.
 *
 * `run` takes argv, streams, the environment and a working directory, and
 * returns an exit code. It never calls `process.exit` and never reads global
 * state, which is what allows the whole CLI to be exercised in-process by
 * the tests as well as from a real shell.
 */
import { parseArgs, booleanOption } from './args.js';
import type { ParsedArgs } from './args.js';
import type { Command, CommandContext } from './command.js';
import { ExitCode } from './exit-codes.js';
import type { ExitCodeValue } from './exit-codes.js';
import { renderCommandHelp, renderRootHelp } from './help.js';
import { Terminal } from './terminal.js';
import type { Streams } from './terminal.js';
import { initCommand } from './commands/init.js';
import { scanCommand } from './commands/scan.js';
import { verifyCommand } from './commands/verify.js';
import { watchCommand } from './commands/watch.js';
import { reportCommand } from './commands/report.js';
import { IntegrityError, describeError } from '../core/errors.js';
import { PRODUCT_NAME, VERSION } from '../version.js';

/** Every command, in the order they appear in help. */
export const COMMANDS: readonly Command[] = [
  initCommand,
  scanCommand,
  verifyCommand,
  watchCommand,
  reportCommand,
];

export interface RunOptions {
  readonly argv: readonly string[];
  readonly streams: Streams;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

/** Runs one command and returns its exit code. */
export async function run(options: RunOptions): Promise<ExitCodeValue> {
  const [first, ...rest] = options.argv;

  // Version and root help are answered before any command lookup, so they
  // work even when the rest of the command line is nonsense.
  if (first === '--version' || first === '-v') {
    plainTerminal(options).out(`${PRODUCT_NAME} v${VERSION}`);
    return ExitCode.Ok;
  }
  if (
    first === undefined ||
    first === '--help' ||
    first === '-h' ||
    first === 'help'
  ) {
    const target = first === 'help' ? rest[0] : undefined;
    const terminal = plainTerminal(options);
    if (target !== undefined) {
      const command = COMMANDS.find((candidate) => candidate.name === target);
      if (!command) {
        terminal.err(`Unknown command: ${target}`);
        return ExitCode.UsageError;
      }
      renderCommandHelp(terminal, command);
      return ExitCode.Ok;
    }
    renderRootHelp(terminal, COMMANDS);
    return first === undefined ? ExitCode.UsageError : ExitCode.Ok;
  }

  const command = COMMANDS.find((candidate) => candidate.name === first);
  if (!command) {
    const terminal = plainTerminal(options);
    terminal.err(`Unknown command: ${first}`);
    terminal.err(
      `Known commands: ${COMMANDS.map((entry) => entry.name).join(', ')}`,
    );
    terminal.err('Run "integrity --help" for usage.');
    return ExitCode.UsageError;
  }

  let parsed: ParsedArgs;
  let terminal: Terminal;
  try {
    parsed = parseArgs(rest, command.options);
    terminal = new Terminal({
      streams: options.streams,
      env: options.env,
      color: booleanOption(parsed, 'color'),
      quiet: booleanOption(parsed, 'quiet') === true,
    });
  } catch (error) {
    return reportFailure(plainTerminal(options), error);
  }

  if (booleanOption(parsed, 'help') === true) {
    renderCommandHelp(terminal, command);
    return ExitCode.Ok;
  }

  const context: CommandContext = {
    terminal,
    env: options.env,
    cwd: options.cwd,
    signal: options.signal ?? new AbortController().signal,
  };

  try {
    return await command.run(context, parsed);
  } catch (error) {
    return reportFailure(terminal, error);
  }
}

function plainTerminal(options: RunOptions): Terminal {
  return new Terminal({ streams: options.streams, env: options.env });
}

/**
 * Turns an error into a message and an exit code. The error's kind decides
 * the code, so a malformed baseline is never mistaken for a clean run by a
 * script reading `$?`.
 */
function reportFailure(terminal: Terminal, error: unknown): ExitCodeValue {
  terminal.clearProgress();
  if (error instanceof IntegrityError) {
    if (error.kind === 'cancelled') {
      terminal.err('Interrupted.');
      return ExitCode.Interrupted;
    }
    terminal.err(`${terminal.style('error', 'red')}: ${error.message}`);
    for (const detail of error.details) terminal.err(`  ${detail}`);
    switch (error.kind) {
      case 'usage':
        return ExitCode.UsageError;
      case 'baseline':
        return ExitCode.BaselineUntrusted;
      case 'io':
      case 'internal':
        return ExitCode.RuntimeError;
    }
  }
  terminal.err(`${terminal.style('error', 'red')}: ${describeError(error)}`);
  return ExitCode.RuntimeError;
}
