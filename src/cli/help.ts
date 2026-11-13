/**
 * Help output.
 *
 * Generated from the same option definitions the parser uses, so the help
 * text cannot describe an option the command does not accept, or omit one
 * it does.
 */
import type { Command } from './command.js';
import type { OptionSpec } from './args.js';
import type { Terminal } from './terminal.js';
import { PRODUCT_NAME, PRODUCT_SUBTITLE, VERSION } from '../version.js';

/** Top-level help. */
export function renderRootHelp(
  terminal: Terminal,
  commands: readonly Command[],
): void {
  terminal.out(`${PRODUCT_NAME} — ${PRODUCT_SUBTITLE}`);
  terminal.out();
  terminal.out(
    terminal.style('Usage:', 'bold') + ' integrity <command> [options]',
  );
  terminal.out();
  terminal.out(terminal.style('Commands:', 'bold'));
  const width = Math.max(...commands.map((command) => command.name.length));
  for (const command of commands) {
    terminal.out(`  ${command.name.padEnd(width + 2)}${command.summary}`);
  }
  terminal.out();
  terminal.out(terminal.style('Global options:', 'bold'));
  terminal.out(
    '  -h, --help       Show help. Use "integrity <command> --help" for details.',
  );
  terminal.out('  -v, --version    Print the installed version.');
  terminal.out(
    '      --no-color   Disable colour. NO_COLOR is honoured automatically.',
  );
  terminal.out(
    '  -q, --quiet      Suppress progress and informational output.',
  );
  terminal.out();
  terminal.out(terminal.style('Getting started:', 'bold'));
  terminal.out('  integrity init ./app        write a configuration file');
  terminal.out('  integrity scan ./app        record the trusted state');
  terminal.out('  integrity verify ./app      check it later');
  terminal.out('  integrity watch ./app       monitor it continuously');
  terminal.out();
  terminal.out(terminal.style('Exit codes:', 'bold'));
  terminal.out(
    '  0 clean   1 changes detected   2 incomplete   3 untrusted baseline',
  );
  terminal.out('  4 runtime error   64 invalid usage   130 interrupted');
  terminal.out();
  terminal.out(
    `${PRODUCT_NAME} v${VERSION} — https://github.com/sablectl/integrity`,
  );
}

/** Help for a single command. */
export function renderCommandHelp(terminal: Terminal, command: Command): void {
  terminal.out(`${PRODUCT_NAME} — ${command.summary}`);
  terminal.out();
  terminal.out(terminal.style('Usage:', 'bold') + ` ${command.usage}`);
  if (command.description.length > 0) {
    terminal.out();
    for (const line of command.description) terminal.out(line);
  }
  terminal.out();
  terminal.out(terminal.style('Options:', 'bold'));
  for (const line of formatOptions(command.options)) terminal.out(line);
  if (command.examples.length > 0) {
    terminal.out();
    terminal.out(terminal.style('Examples:', 'bold'));
    for (const example of command.examples) terminal.out(`  ${example}`);
  }
}

/** Lays out the option table. */
export function formatOptions(options: readonly OptionSpec[]): string[] {
  const rows = options.map((option) => {
    const short = option.short === undefined ? '    ' : `-${option.short}, `;
    const value =
      option.placeholder === undefined ? '' : ` ${option.placeholder}`;
    return {
      left: `  ${short}--${option.name}${value}`,
      right: option.description,
    };
  });
  const width = Math.max(...rows.map((row) => row.left.length));
  return rows.map((row) => `${row.left.padEnd(width + 2)}${row.right}`);
}
