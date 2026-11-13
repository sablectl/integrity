/**
 * Error types used across the toolkit.
 *
 * Every error that can reach the command layer carries a `kind`, because the
 * process exit code is derived from the kind rather than from string
 * matching on a message.
 */

export type ErrorKind = 'usage' | 'baseline' | 'io' | 'cancelled' | 'internal';

export class IntegrityError extends Error {
  readonly kind: ErrorKind;
  readonly details: readonly string[];

  constructor(
    kind: ErrorKind,
    message: string,
    details: readonly string[] = [],
  ) {
    super(message);
    this.name = 'IntegrityError';
    this.kind = kind;
    this.details = details;
  }
}

export class UsageError extends IntegrityError {
  constructor(message: string, details: readonly string[] = []) {
    super('usage', message, details);
    this.name = 'UsageError';
  }
}

/**
 * The baseline is the trusted reference state. A baseline that cannot be
 * parsed, fails schema validation, or fails its keyed integrity check is
 * never treated as a merely inconvenient parse failure: it is reported
 * distinctly so that an operator can tell "the baseline is untrustworthy"
 * apart from "the monitored files changed".
 */
export class BaselineError extends IntegrityError {
  constructor(message: string, details: readonly string[] = []) {
    super('baseline', message, details);
    this.name = 'BaselineError';
  }
}

export class IoError extends IntegrityError {
  constructor(message: string, details: readonly string[] = []) {
    super('io', message, details);
    this.name = 'IoError';
  }
}

export class CancelledError extends IntegrityError {
  constructor(message = 'Operation cancelled.') {
    super('cancelled', message);
    this.name = 'CancelledError';
  }
}

/** Extracts a human-readable message from an unknown thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error.';
}

/** Returns the `errno` code of a Node filesystem error, when present. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    if (typeof code === 'string') return code;
  }
  return undefined;
}
