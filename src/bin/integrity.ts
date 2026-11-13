#!/usr/bin/env node
/**
 * Process entry point.
 *
 * Everything that touches the process — signals, the exit code, the real
 * streams — lives here and nowhere else. SIGINT and SIGTERM abort the shared
 * signal rather than killing the process outright, so a scan in progress
 * closes its file handles and a watch session prints its summary before
 * exiting.
 */
import { run } from '../cli/run.js';
import { ExitCode } from '../cli/exit-codes.js';

const controller = new AbortController();
let interrupted = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (interrupted) {
      // A second interrupt means the operator wants out now.
      process.exit(ExitCode.Interrupted);
    }
    interrupted = true;
    controller.abort();
  });
}

// A closed pipe is normal: `integrity verify --json | head` should end
// quietly rather than with an unhandled EPIPE stack trace.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(ExitCode.Ok);
  throw error;
});

const code = await run({
  argv: process.argv.slice(2),
  streams: { stdout: process.stdout, stderr: process.stderr },
  env: process.env,
  cwd: process.cwd(),
  signal: controller.signal,
});

process.exitCode =
  interrupted && code === ExitCode.Ok ? ExitCode.Interrupted : code;
