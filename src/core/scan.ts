/**
 * Directory traversal and hashing.
 *
 * Traversal is iterative rather than recursive, so a deep tree cannot
 * exhaust the call stack, and it records every directory it enters by
 * device and inode so a symlink cycle terminates instead of looping
 * forever. Hashing runs behind a bounded worker pool: a directory with a
 * hundred thousand files opens a handful of descriptors at a time, not a
 * hundred thousand.
 *
 * Anything that cannot be hashed — an unreadable file, a file above the size
 * limit, a socket, a symlink when links are not followed — is recorded as a
 * skipped entry rather than dropped. Verification refuses to call a run
 * clean when entries were skipped, which is only possible because nothing is
 * silently discarded here.
 */
import { lstat, readdir, readlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CancelledError, IoError, describeError, errorCode } from './errors.js';
import { ExcludeMatcher } from './exclude.js';
import {
  FileTooLargeError,
  HashCancelledError,
  hashFile,
  hashText,
} from './hash.js';
import { comparePaths, relativeInside, toPosix } from './paths.js';
import type {
  BaselineEntry,
  BaselineOptions,
  BaselineStats,
  ScanProgress,
  ScanResult,
  SkippedEntry,
} from './types.js';

/** Default number of files hashed at the same time. */
export const DEFAULT_CONCURRENCY = 8;

/** Default refusal threshold for a single file, in bytes. */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 512 * 1024 * 1024;

/** Default limit on directory depth below the root. */
export const DEFAULT_MAX_DEPTH = 64;

export interface ScanOptions {
  readonly root: string;
  readonly exclude?: readonly string[];
  readonly followSymlinks?: boolean;
  readonly recordMetadata?: boolean;
  readonly oneFileSystem?: boolean;
  readonly maxFileSizeBytes?: number | null;
  readonly maxDepth?: number | null;
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ScanProgress) => void;
}

interface PendingFile {
  readonly absolutePath: string;
  readonly relativePath: string;
}

interface Queued {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly depth: number;
}

/** Resolves user-supplied scan options into the recorded option set. */
export function resolveScanOptions(options: ScanOptions): BaselineOptions {
  return {
    exclude: [...(options.exclude ?? [])],
    followSymlinks: options.followSymlinks ?? false,
    recordMetadata: options.recordMetadata ?? true,
    oneFileSystem: options.oneFileSystem ?? false,
    maxFileSizeBytes:
      options.maxFileSizeBytes === undefined
        ? DEFAULT_MAX_FILE_SIZE_BYTES
        : options.maxFileSizeBytes,
    maxDepth:
      options.maxDepth === undefined ? DEFAULT_MAX_DEPTH : options.maxDepth,
  };
}

/**
 * Walks `root` and returns every entry it could record, plus every entry it
 * could not.
 */
export async function scanDirectory(options: ScanOptions): Promise<ScanResult> {
  const startedAt = Date.now();
  const root = resolve(options.root);
  const resolved = resolveScanOptions(options);
  const matcher = new ExcludeMatcher(resolved.exclude);
  const signal = options.signal;

  const rootStats = await lstat(root).catch((error: unknown) => {
    throw new IoError(`Cannot read ${root}: ${describeError(error)}`);
  });
  if (!rootStats.isDirectory()) {
    throw new IoError(`Not a directory: ${root}`);
  }
  const rootDevice = rootStats.dev;

  const entries: BaselineEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const pendingFiles: PendingFile[] = [];
  const visitedDirectories = new Set<string>([
    inodeKey(rootStats.dev, rootStats.ino),
  ]);
  let directories = 0;
  let symlinks = 0;

  const queue: Queued[] = [{ absolutePath: root, relativePath: '', depth: 0 }];
  while (queue.length > 0) {
    throwIfAborted(signal);
    const current = queue.shift();
    /* c8 ignore next */
    if (!current) break;
    directories += 1;

    let dirents;
    try {
      dirents = await readdir(current.absolutePath, { withFileTypes: true });
    } catch (error) {
      skipped.push({
        path: current.relativePath,
        reason: 'unreadable',
        message: `Cannot list directory: ${describeError(error)}`,
      });
      continue;
    }

    for (const dirent of dirents) {
      throwIfAborted(signal);
      const absolutePath = join(current.absolutePath, dirent.name);
      const relativePath =
        current.relativePath === ''
          ? toPosix(dirent.name)
          : `${current.relativePath}/${toPosix(dirent.name)}`;

      // Defence in depth: a crafted directory name can never take traversal
      // outside the root, but the check costs nothing and the guarantee is
      // worth stating in code rather than in a comment alone.
      relativeInside(root, absolutePath);

      if (dirent.isSymbolicLink()) {
        if (matcher.matches(relativePath, false)) continue;
        const handled = await handleSymlink({
          absolutePath,
          relativePath,
          root,
          resolved,
          matcher,
          rootDevice,
          depth: current.depth,
          visitedDirectories,
          queue,
          entries,
          skipped,
          pendingFiles,
        });
        if (handled === 'symlink-entry') symlinks += 1;
        continue;
      }

      if (dirent.isDirectory()) {
        if (matcher.matches(relativePath, true)) continue;
        await enqueueDirectory({
          absolutePath,
          relativePath,
          depth: current.depth + 1,
          resolved,
          rootDevice,
          visitedDirectories,
          queue,
          skipped,
        });
        continue;
      }

      if (matcher.matches(relativePath, false)) continue;

      if (dirent.isFile()) {
        pendingFiles.push({ absolutePath, relativePath });
        continue;
      }

      skipped.push({
        path: relativePath,
        reason: 'unsupported-type',
        message: 'Not a regular file, symlink or directory.',
      });
    }
  }

  let filesHashed = 0;
  let bytesHashed = 0;
  const report = (currentPath: string): void => {
    options.onProgress?.({
      filesHashed,
      bytesHashed,
      skipped: skipped.length,
      currentPath,
    });
  };

  await runPool(
    pendingFiles,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    signal,
    async (file) => {
      try {
        const digest = await hashFile(file.absolutePath, {
          maxBytes: resolved.maxFileSizeBytes,
          ...(signal ? { signal } : {}),
        });
        entries.push({
          path: file.relativePath,
          type: 'file',
          size: digest.size,
          sha256: digest.sha256,
          mtimeMs: digest.mtimeMs,
          ...(resolved.recordMetadata
            ? { mode: digest.mode, uid: digest.uid, gid: digest.gid }
            : {}),
        });
        filesHashed += 1;
        bytesHashed += digest.size;
      } catch (error) {
        if (error instanceof CancelledError) throw error;
        if (error instanceof HashCancelledError || isAbortError(error)) {
          throw new CancelledError();
        }
        if (error instanceof FileTooLargeError) {
          skipped.push({
            path: file.relativePath,
            reason: 'too-large',
            message: error.message,
          });
        } else if (errorCode(error) === 'ENOENT') {
          // The file vanished between listing and hashing. That is a real
          // event on a live filesystem, and it is reported rather than
          // quietly dropped.
          skipped.push({
            path: file.relativePath,
            reason: 'unreadable',
            message: 'File disappeared during the scan.',
          });
        } else {
          skipped.push({
            path: file.relativePath,
            reason: 'unreadable',
            message: describeError(error),
          });
        }
      }
      report(file.relativePath);
    },
  );

  entries.sort((left, right) => comparePaths(left.path, right.path));
  skipped.sort((left, right) => comparePaths(left.path, right.path));

  const stats: BaselineStats = {
    files: entries.filter((entry) => entry.type === 'file').length,
    symlinks,
    directories,
    totalBytes: entries.reduce(
      (total, entry) => (entry.type === 'file' ? total + entry.size : total),
      0,
    ),
    skipped: skipped.length,
  };

  return {
    root,
    options: resolved,
    entries,
    skipped,
    stats,
    durationMs: Date.now() - startedAt,
  };
}

interface SymlinkContext {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly root: string;
  readonly resolved: BaselineOptions;
  readonly matcher: ExcludeMatcher;
  readonly rootDevice: number;
  readonly depth: number;
  readonly visitedDirectories: Set<string>;
  readonly queue: Queued[];
  readonly entries: BaselineEntry[];
  readonly skipped: SkippedEntry[];
  readonly pendingFiles: PendingFile[];
}

/**
 * Symlinks are not followed by default. A link is recorded as an entry whose
 * hash covers the link target string, so repointing it at another file is a
 * modification, and following it is an opt-in decision rather than something
 * an attacker makes for the operator by planting a link.
 */
async function handleSymlink(
  context: SymlinkContext,
): Promise<'symlink-entry' | 'followed' | 'skipped'> {
  if (!context.resolved.followSymlinks) {
    try {
      const target = await readlink(context.absolutePath);
      const linkStats = await lstat(context.absolutePath);
      context.entries.push({
        path: context.relativePath,
        type: 'symlink',
        size: Buffer.byteLength(target, 'utf8'),
        sha256: hashText(target),
        mtimeMs: Math.trunc(linkStats.mtimeMs),
        target,
        ...(context.resolved.recordMetadata
          ? {
              mode: linkStats.mode & 0o7777,
              uid: linkStats.uid,
              gid: linkStats.gid,
            }
          : {}),
      });
      return 'symlink-entry';
    } catch (error) {
      context.skipped.push({
        path: context.relativePath,
        reason: 'unreadable',
        message: `Cannot read link: ${describeError(error)}`,
      });
      return 'skipped';
    }
  }

  let targetStats;
  try {
    targetStats = await stat(context.absolutePath);
  } catch (error) {
    context.skipped.push({
      path: context.relativePath,
      reason: 'unreadable',
      message: `Cannot resolve link: ${describeError(error)}`,
    });
    return 'skipped';
  }

  if (targetStats.isDirectory()) {
    if (context.matcher.matches(context.relativePath, true)) return 'skipped';
    await enqueueDirectory({
      absolutePath: context.absolutePath,
      relativePath: context.relativePath,
      depth: context.depth + 1,
      resolved: context.resolved,
      rootDevice: context.rootDevice,
      visitedDirectories: context.visitedDirectories,
      queue: context.queue,
      skipped: context.skipped,
      statsOverride: targetStats,
    });
    return 'followed';
  }

  if (targetStats.isFile()) {
    context.pendingFiles.push({
      absolutePath: context.absolutePath,
      relativePath: context.relativePath,
    });
    return 'followed';
  }

  context.skipped.push({
    path: context.relativePath,
    reason: 'unsupported-type',
    message: 'Link target is not a regular file or directory.',
  });
  return 'skipped';
}

interface EnqueueContext {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly depth: number;
  readonly resolved: BaselineOptions;
  readonly rootDevice: number;
  readonly visitedDirectories: Set<string>;
  readonly queue: Queued[];
  readonly skipped: SkippedEntry[];
  readonly statsOverride?: { dev: number; ino: number };
}

async function enqueueDirectory(context: EnqueueContext): Promise<void> {
  const { resolved } = context;
  if (resolved.maxDepth !== null && context.depth > resolved.maxDepth) {
    context.skipped.push({
      path: context.relativePath,
      reason: 'max-depth',
      message: `Directory is deeper than the limit of ${String(resolved.maxDepth)}.`,
    });
    return;
  }

  let dirStats = context.statsOverride;
  if (!dirStats) {
    try {
      dirStats = await lstat(context.absolutePath);
    } catch (error) {
      context.skipped.push({
        path: context.relativePath,
        reason: 'unreadable',
        message: `Cannot stat directory: ${describeError(error)}`,
      });
      return;
    }
  }

  if (resolved.oneFileSystem && dirStats.dev !== context.rootDevice) {
    context.skipped.push({
      path: context.relativePath,
      reason: 'other-filesystem',
      message: 'Directory is on a different filesystem.',
    });
    return;
  }

  const key = inodeKey(dirStats.dev, dirStats.ino);
  if (context.visitedDirectories.has(key)) {
    context.skipped.push({
      path: context.relativePath,
      reason: 'cycle',
      message: 'Directory has already been visited; traversal stopped here.',
    });
    return;
  }
  context.visitedDirectories.add(key);

  context.queue.push({
    absolutePath: context.absolutePath,
    relativePath: context.relativePath,
    depth: context.depth,
  });
}

function inodeKey(device: number, inode: number): string {
  return `${String(device)}:${String(inode)}`;
}

/** Runs `worker` over `items` with at most `limit` in flight. */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal | undefined,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const runners: Promise<void>[] = [];
  for (let index = 0; index < width; index += 1) {
    runners.push(
      (async () => {
        while (next < items.length) {
          throwIfAborted(signal);
          const item = items[next];
          next += 1;
          /* c8 ignore next */
          if (item === undefined) continue;
          await worker(item);
        }
      })(),
    );
  }
  await Promise.all(runners);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new CancelledError();
}

function isAbortError(error: unknown): boolean {
  return (
    errorCode(error) === 'ABORT_ERR' ||
    (error instanceof Error && error.name === 'AbortError')
  );
}
