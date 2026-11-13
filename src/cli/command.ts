/**
 * The command contract.
 *
 * Every command is a plain object with its options, its help text and a
 * handler that returns an exit code. Nothing calls `process.exit` and
 * nothing writes to `process.stdout` directly: the streams, the environment
 * and the working directory all arrive through the context, which is what
 * makes the commands testable without spawning a process.
 */
import type { OptionSpec, ParsedArgs } from './args.js';
import type { Terminal } from './terminal.js';
import type { ExitCodeValue } from './exit-codes.js';

export interface CommandContext {
  readonly terminal: Terminal;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Aborted on SIGINT and SIGTERM so long runs stop promptly. */
  readonly signal: AbortSignal;
}

export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly description: readonly string[];
  readonly options: readonly OptionSpec[];
  readonly examples: readonly string[];
  run(context: CommandContext, parsed: ParsedArgs): Promise<ExitCodeValue>;
}
