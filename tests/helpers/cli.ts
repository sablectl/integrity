/**
 * Runs the CLI in-process with captured streams.
 *
 * `run` takes its streams, environment and working directory as arguments,
 * so the whole command line can be exercised without spawning a process.
 * The integration suite still spawns the real binary; this is for the fast
 * path.
 */
import { Writable } from 'node:stream';
import { run } from '../../src/cli/run.js';

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

class Capture extends Writable {
  chunks: string[] = [];
  isTTY = false;

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(String(chunk));
    callback();
  }

  get text(): string {
    return this.chunks.join('');
  }
}

export interface RunCliOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

/** Runs one command line and captures its output and exit code. */
export async function runCli(
  argv: readonly string[],
  options: RunCliOptions,
): Promise<CliResult> {
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await run({
    argv,
    streams: { stdout, stderr },
    // NO_COLOR keeps assertions free of escape sequences unless a test
    // deliberately asks for colour.
    env: { NO_COLOR: '1', ...options.env },
    cwd: options.cwd,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

/** Parses the JSON written to stdout by a command. */
export function parseJsonOutput(result: CliResult): unknown {
  return JSON.parse(result.stdout) as unknown;
}
