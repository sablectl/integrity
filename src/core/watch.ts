/**
 * Directory monitoring.
 *
 * Two mechanisms run together, because neither is sufficient on its own:
 *
 * 1. A recursive filesystem watcher, which is fast but not a security
 *    control. Watchers coalesce events, drop them under load, miss changes
 *    made while the process was not running, and behave differently on every
 *    platform. Treating a watcher as a complete record of what happened to a
 *    directory is the most common way to build a monitoring tool that
 *    quietly misses things.
 * 2. A periodic full verification, which is the authoritative check. It is
 *    slower, and it is the reason watch mode can claim to have noticed
 *    anything at all.
 *
 * Events are debounced so that a single `npm install` does not produce
 * thousands of checks, and the pending set is bounded: past the cap the
 * batch is abandoned in favour of one full verification, so memory stays
 * flat no matter how violent the write burst is.
 */
import { watch as fsWatch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { normalize } from 'node:path';
import { CancelledError, describeError } from './errors.js';
import { ExcludeMatcher } from './exclude.js';
import { scanDirectory } from './scan.js';
import type { ScanOptions } from './scan.js';
import { compareWithBaseline } from './verify.js';
import type { CompareOptions, Finding, VerificationReport } from './verify.js';
import type { Baseline } from './types.js';
import { toPosix } from './paths.js';

/** Largest number of distinct paths held between two checks. */
export const DEFAULT_MAX_PENDING_PATHS = 5000;

/** Default quiet period before a batch of events is acted on. */
export const DEFAULT_DEBOUNCE_MS = 250;

/** Default gap between authoritative full verifications. */
export const DEFAULT_INTERVAL_SECONDS = 300;

export type WatchEvent =
  | {
      readonly type: 'started';
      readonly root: string;
      readonly recursive: boolean;
    }
  | {
      readonly type: 'activity';
      readonly paths: readonly string[];
      readonly truncated: boolean;
    }
  | {
      readonly type: 'verification';
      readonly trigger: 'activity' | 'interval' | 'initial';
      readonly report: VerificationReport;
    }
  | { readonly type: 'findings'; readonly findings: readonly Finding[] }
  | { readonly type: 'warning'; readonly message: string }
  | { readonly type: 'stopped'; readonly reason: 'signal' | 'error' };

export interface WatchOptions {
  readonly baseline: Baseline;
  readonly scan: ScanOptions;
  readonly compare?: CompareOptions;
  readonly debounceMs?: number;
  readonly intervalSeconds?: number;
  readonly maxPendingPaths?: number;
  /** Run one verification before watching starts. */
  readonly verifyOnStart?: boolean;
  readonly signal: AbortSignal;
  readonly onEvent: (event: WatchEvent) => void;
}

export interface WatchSummary {
  readonly verifications: number;
  readonly findingsSeen: number;
  readonly lastStatus: VerificationReport['status'] | 'none';
}

/**
 * Watches a directory until the supplied signal is aborted.
 *
 * Resolves with a summary; it does not throw on cancellation, because an
 * operator pressing Ctrl-C is a normal end to a watch session rather than a
 * failure.
 */
export async function watchDirectory(
  options: WatchOptions,
): Promise<WatchSummary> {
  const root = options.scan.root;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const maxPending = options.maxPendingPaths ?? DEFAULT_MAX_PENDING_PATHS;
  const matcher = new ExcludeMatcher(options.scan.exclude ?? []);

  let verifications = 0;
  let findingsSeen = 0;
  let lastStatus: WatchSummary['lastStatus'] = 'none';
  let running = false;
  let rerunRequested = false;
  let pending = new Set<string>();
  let truncated = false;
  let debounceTimer: NodeJS.Timeout | undefined;
  let intervalTimer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;

  const runVerification = async (
    trigger: 'activity' | 'interval' | 'initial',
  ): Promise<void> => {
    if (options.signal.aborted) return;
    if (running) {
      // A check is already in flight. Remember that another is due rather
      // than starting a second concurrent scan of the same tree.
      rerunRequested = true;
      return;
    }
    running = true;
    try {
      const scan = await scanDirectory({
        ...options.scan,
        signal: options.signal,
      });
      const report = compareWithBaseline(
        options.baseline,
        scan,
        options.compare ?? {},
      );
      verifications += 1;
      findingsSeen += report.findings.length;
      lastStatus = report.status;
      options.onEvent({ type: 'verification', trigger, report });
      if (report.findings.length > 0) {
        options.onEvent({ type: 'findings', findings: report.findings });
      }
    } catch (error) {
      if (error instanceof CancelledError) return;
      options.onEvent({
        type: 'warning',
        message: `Verification failed: ${describeError(error)}`,
      });
    } finally {
      running = false;
      if (rerunRequested && !options.signal.aborted) {
        rerunRequested = false;
        void runVerification('activity');
      }
    }
  };

  const flush = (): void => {
    debounceTimer = undefined;
    const paths = [...pending].sort();
    pending = new Set<string>();
    const wasTruncated = truncated;
    truncated = false;
    options.onEvent({ type: 'activity', paths, truncated: wasTruncated });
    void runVerification('activity');
  };

  const noteActivity = (relativePath: string | undefined): void => {
    if (relativePath !== undefined) {
      if (matcher.matches(relativePath, false)) return;
      if (pending.size >= maxPending) {
        // Bounded memory: stop accumulating and let the full verification
        // that follows establish the truth.
        truncated = true;
      } else {
        pending.add(relativePath);
      }
    } else {
      truncated = true;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, debounceMs);
  };

  let recursive = true;
  try {
    watcher = fsWatch(root, { recursive: true, persistent: true });
  } catch {
    // Recursive watching is not available everywhere. Fall back to watching
    // the top level only and lean harder on the periodic verification,
    // saying so rather than pretending coverage is complete.
    recursive = false;
    try {
      watcher = fsWatch(root, { recursive: false, persistent: true });
    } catch (error) {
      options.onEvent({
        type: 'warning',
        message: `Filesystem watching is unavailable (${describeError(error)}); falling back to periodic verification only.`,
      });
      watcher = undefined;
    }
  }
  if (!recursive && watcher) {
    options.onEvent({
      type: 'warning',
      message:
        'Recursive watching is not supported here; only the top level is watched. Periodic verification still covers the whole tree.',
    });
  }

  watcher?.on('change', (_event, filename) => {
    noteActivity(normalizeFilename(filename));
  });
  watcher?.on('error', (error: unknown) => {
    options.onEvent({
      type: 'warning',
      message: `Watcher error: ${describeError(error)}. Continuing with periodic verification.`,
    });
    watcher?.close();
    watcher = undefined;
  });

  options.onEvent({
    type: 'started',
    root,
    recursive: recursive && watcher !== undefined,
  });

  if (options.verifyOnStart ?? true) {
    await runVerification('initial');
  }

  if (intervalSeconds > 0) {
    intervalTimer = setInterval(() => {
      void runVerification('interval');
    }, intervalSeconds * 1000);
  }

  await new Promise<void>((resolveWait) => {
    if (options.signal.aborted) {
      resolveWait();
      return;
    }
    options.signal.addEventListener(
      'abort',
      () => {
        resolveWait();
      },
      { once: true },
    );
  });

  if (debounceTimer) clearTimeout(debounceTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  watcher?.close();
  options.onEvent({ type: 'stopped', reason: 'signal' });

  return { verifications, findingsSeen, lastStatus };
}

/**
 * Node reports the changed path relative to the watched directory, in the
 * platform's own separator form. An absent name means the platform could
 * not say what changed, which is treated as "something did".
 */
function normalizeFilename(
  filename: string | Buffer | null,
): string | undefined {
  if (filename === null) return undefined;
  const text =
    typeof filename === 'string' ? filename : filename.toString('utf8');
  if (text === '') return undefined;
  return toPosix(normalize(text));
}
