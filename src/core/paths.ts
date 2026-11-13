/**
 * Path handling.
 *
 * Every path that reaches the filesystem is resolved to an absolute path
 * first, and every path that is written into a baseline is stored relative
 * to the scan root with `/` separators, so a baseline taken on one machine
 * can be read on another.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { UsageError } from './errors.js';

/** Converts a native path to the POSIX form used inside baselines. */
export function toPosix(nativePath: string): string {
  return sep === '/' ? nativePath : nativePath.split(sep).join('/');
}

/** Converts a baseline path back to the native form. */
export function fromPosix(posixPath: string): string {
  return sep === '/' ? posixPath : posixPath.split('/').join(sep);
}

/**
 * Returns the path of `target` relative to `root`, in POSIX form.
 *
 * Throws when the result would escape the root. Traversal builds its paths
 * by joining known-safe segments, so this is a second line of defence rather
 * than the only one, but a baseline entry that points outside the tree it
 * claims to describe is exactly the kind of thing worth refusing.
 */
export function relativeInside(root: string, target: string): string {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UsageError(`Path escapes the scan root: ${target}`, [
      `Root: ${root}`,
    ]);
  }
  return toPosix(rel);
}

/**
 * Validates a path read from a baseline before it is used to touch the
 * filesystem. Baselines are untrusted input: a hostile one could otherwise
 * ask the verifier to read `../../etc/shadow` and report on it.
 */
export function assertSafeRelativePath(relativePath: string): void {
  if (relativePath === '') {
    throw new UsageError('Baseline entry has an empty path.');
  }
  if (relativePath.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(relativePath)) {
    throw new UsageError(
      `Baseline entry path must be relative: ${relativePath}`,
    );
  }
  if (relativePath.includes('\0')) {
    throw new UsageError('Baseline entry path contains a NUL byte.');
  }
  const segments = relativePath.split('/');
  if (segments.includes('..')) {
    throw new UsageError(
      `Baseline entry path escapes the root: ${relativePath}`,
    );
  }
}

/** Compares baseline paths by UTF-16 code unit, giving deterministic order. */
export function comparePaths(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
