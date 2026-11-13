/**
 * Public API.
 *
 * The command line is the primary interface, but the engine underneath it
 * is ordinary TypeScript and is exported so it can be embedded in a larger
 * tool: scan a directory, build and sign a baseline, compare a later scan
 * against it, and render the result.
 */
export { BASELINE_SCHEMA_VERSION, HASH_ALGORITHM } from './core/types.js';
export type {
  Baseline,
  BaselineEntry,
  BaselineOptions,
  BaselineSignature,
  BaselineStats,
  EntryType,
  ScanProgress,
  ScanResult,
  SkipReason,
  SkippedEntry,
  UnsignedBaseline,
} from './core/types.js';

export {
  BASELINE_FILE_MODE,
  DEFAULT_BASELINE_PATH,
  buildBaseline,
  parseBaseline,
  readBaseline,
  serializeBaseline,
  validateBaseline,
  writeBaseline,
} from './core/baseline.js';

export {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  resolveScanOptions,
  scanDirectory,
} from './core/scan.js';
export type { ScanOptions } from './core/scan.js';

export {
  HASH_CHUNK_BYTES,
  hashBytes,
  hashFile,
  hashText,
} from './core/hash.js';
export type { FileDigest } from './core/hash.js';

export { ExcludeMatcher, compilePattern } from './core/exclude.js';

export { canonicalize } from './core/canonical.js';

export {
  KEY_ENV_VAR,
  MIN_KEY_BYTES,
  computeTag,
  loadKeyFromEnvironment,
  loadKeyFromFile,
  signBaseline,
  verifySignature,
} from './core/signature.js';
export type { SignatureState, SigningKey } from './core/signature.js';

export { compareWithBaseline, severityFor } from './core/verify.js';
export type {
  ChangeType,
  CompareOptions,
  Finding,
  Severity,
  VerificationReport,
  VerificationStatus,
  VerificationSummary,
} from './core/verify.js';

export {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_MAX_PENDING_PATHS,
  watchDirectory,
} from './core/watch.js';
export type { WatchEvent, WatchOptions, WatchSummary } from './core/watch.js';

export {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  loadConfig,
  parseConfig,
  serializeConfig,
} from './core/config.js';
export type { IntegrityConfig } from './core/config.js';

export {
  BaselineError,
  CancelledError,
  IntegrityError,
  IoError,
  UsageError,
} from './core/errors.js';

export { parseReport, serializeReport } from './report/json.js';
export { renderReport } from './report/human.js';

export { ExitCode } from './cli/exit-codes.js';
export type { ExitCodeValue } from './cli/exit-codes.js';
export { run } from './cli/run.js';
export type { RunOptions } from './cli/run.js';

export { PRODUCT_NAME, PRODUCT_SUBTITLE, VERSION } from './version.js';
