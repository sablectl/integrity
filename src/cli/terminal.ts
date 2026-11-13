/**
 * Terminal output.
 *
 * Colour is an enhancement, never a carrier of meaning: every line reads the
 * same on a monochrome terminal, through a pipe, or in a CI log. Colour is
 * disabled when output is not a TTY, when `NO_COLOR` is set, when `TERM` is
 * `dumb`, and whenever `--no-color` is passed.
 *
 * Progress is written to stderr so that stdout stays a clean, machine-
 * readable stream, and it is suppressed entirely when stderr is not a TTY —
 * a CI log does not benefit from a thousand redrawn counters.
 */

export interface Streams {
  readonly stdout: NodeJS.WritableStream & { isTTY?: boolean };
  readonly stderr: NodeJS.WritableStream & { isTTY?: boolean };
}

export interface TerminalOptions {
  readonly streams: Streams;
  readonly env: NodeJS.ProcessEnv;
  /** Explicit `--color` / `--no-color`; undefined means auto-detect. */
  readonly color?: boolean | undefined;
  readonly quiet?: boolean;
}

const RESET = '\u001B[0m';
const CODES = {
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  blue: '\u001B[34m',
  magenta: '\u001B[35m',
  cyan: '\u001B[36m',
} as const;

export type Style = keyof typeof CODES;

/** Decides whether colour should be used. */
export function shouldUseColor(
  stream: { isTTY?: boolean },
  env: NodeJS.ProcessEnv,
  explicit: boolean | undefined,
): boolean {
  if (explicit !== undefined) return explicit;
  // https://no-color.org: any value, including an empty one, disables colour.
  if (env['NO_COLOR'] !== undefined) return false;
  if (env['FORCE_COLOR'] !== undefined && env['FORCE_COLOR'] !== '0')
    return true;
  if (env['TERM'] === 'dumb') return false;
  return stream.isTTY === true;
}

export class Terminal {
  private readonly streams: Streams;
  private readonly colorEnabled: boolean;
  private readonly quiet: boolean;
  private progressActive = false;

  constructor(options: TerminalOptions) {
    this.streams = options.streams;
    this.colorEnabled = shouldUseColor(
      options.streams.stdout,
      options.env,
      options.color,
    );
    this.quiet = options.quiet ?? false;
  }

  get useColor(): boolean {
    return this.colorEnabled;
  }

  /** Wraps text in a style, or returns it unchanged when colour is off. */
  style(text: string, ...styles: readonly Style[]): string {
    if (!this.colorEnabled || styles.length === 0) return text;
    const prefix = styles.map((name) => CODES[name]).join('');
    return `${prefix}${text}${RESET}`;
  }

  /** Writes a line to stdout. */
  out(line = ''): void {
    this.clearProgress();
    this.streams.stdout.write(`${line}\n`);
  }

  /** Writes a line to stderr. */
  err(line = ''): void {
    this.clearProgress();
    this.streams.stderr.write(`${line}\n`);
  }

  /** Writes an informational line to stderr, unless quiet. */
  note(line: string): void {
    if (this.quiet) return;
    this.err(line);
  }

  /**
   * Replaces the current progress line. Only ever written to an interactive
   * stderr, so piped and redirected output stays free of control characters.
   */
  progress(line: string): void {
    if (this.quiet) return;
    if (this.streams.stderr.isTTY !== true) return;
    const truncated = line.length > 100 ? `${line.slice(0, 97)}...` : line;
    this.streams.stderr.write(`\r\u001B[2K${truncated}`);
    this.progressActive = true;
  }

  /** Removes any progress line still on screen. */
  clearProgress(): void {
    if (!this.progressActive) return;
    this.streams.stderr.write('\r\u001B[2K');
    this.progressActive = false;
  }
}
