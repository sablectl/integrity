/**
 * Exit codes.
 *
 * The codes are a contract with scripts and CI pipelines, so they are
 * defined once, here, and documented in the command reference. The important
 * distinction is between 0, 1 and 2: "everything matched", "something
 * changed", and "we could not check everything, so we cannot tell you that
 * nothing changed".
 */

export const ExitCode = {
  /** Everything checked, nothing changed. */
  Ok: 0,
  /** Verification completed and found differences from the baseline. */
  ChangesDetected: 1,
  /** No changes found, but some entries could not be checked. */
  Incomplete: 2,
  /** The baseline is missing, malformed, or failed its integrity check. */
  BaselineUntrusted: 3,
  /** A filesystem or runtime failure prevented the command from finishing. */
  RuntimeError: 4,
  /** Invalid command line. */
  UsageError: 64,
  /** Interrupted by a signal. */
  Interrupted: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
