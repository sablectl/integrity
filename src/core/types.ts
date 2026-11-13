/**
 * The baseline data model.
 *
 * The baseline is the trusted reference state of a directory tree. It is
 * written as JSON so that it can be reviewed, diffed and stored in version
 * control, and it carries an explicit schema version so that a future format
 * change can be detected rather than silently misread.
 */

/** Current baseline schema version. Incremented on breaking format changes. */
export const BASELINE_SCHEMA_VERSION = 1;

/** The only hash algorithm this release produces. */
export const HASH_ALGORITHM = 'sha256';

/** What a recorded entry is on disk. */
export type EntryType = 'file' | 'symlink';

/** One recorded filesystem entry. */
export interface BaselineEntry {
  /** Path relative to the baseline root, always with `/` separators. */
  readonly path: string;
  readonly type: EntryType;
  /**
   * File size in bytes. For a symlink this is the byte length of the link
   * target, not the size of whatever it points at.
   */
  readonly size: number;
  /**
   * Lowercase hex SHA-256. For a regular file this is the hash of the file
   * contents; for a symlink it is the hash of the link target string, so that
   * repointing a link is detected as a modification.
   */
  readonly sha256: string;
  /** Modification time in milliseconds since the Unix epoch. */
  readonly mtimeMs: number;
  /** POSIX permission bits, recorded only when metadata recording is on. */
  readonly mode?: number;
  /** Owner uid, recorded only when metadata recording is on. */
  readonly uid?: number;
  /** Owner gid, recorded only when metadata recording is on. */
  readonly gid?: number;
  /** Link target, present only for symlink entries. */
  readonly target?: string;
}

/** Why an entry present on disk could not be recorded or checked. */
export type SkipReason =
  | 'unreadable'
  | 'too-large'
  | 'symlink'
  | 'other-filesystem'
  | 'max-depth'
  | 'unsupported-type'
  | 'cycle';

/** An entry that exists but was not hashed. */
export interface SkippedEntry {
  readonly path: string;
  readonly reason: SkipReason;
  readonly message: string;
}

/** Scan options recorded inside the baseline so verification can match them. */
export interface BaselineOptions {
  readonly exclude: readonly string[];
  readonly followSymlinks: boolean;
  readonly recordMetadata: boolean;
  readonly oneFileSystem: boolean;
  /** Maximum file size that will be hashed, in bytes. `null` means no limit. */
  readonly maxFileSizeBytes: number | null;
  /** Maximum directory depth below the root. `null` means no limit. */
  readonly maxDepth: number | null;
}

/** A keyed integrity tag over the baseline body. */
export interface BaselineSignature {
  readonly algorithm: 'hmac-sha256';
  /**
   * Optional non-secret label naming the key that was used, so a deployment
   * rotating keys can tell which one applies. Never contains key material.
   */
  readonly keyId?: string;
  /** Lowercase hex HMAC over the canonical encoding of the baseline body. */
  readonly value: string;
}

/** Totals describing the recorded tree. */
export interface BaselineStats {
  readonly files: number;
  readonly symlinks: number;
  readonly directories: number;
  readonly totalBytes: number;
  readonly skipped: number;
}

/** A complete baseline document. */
export interface Baseline {
  readonly schemaVersion: number;
  readonly tool: { readonly name: string; readonly version: string };
  readonly createdAt: string;
  /** Absolute root path at creation time. Informational only. */
  readonly root: string;
  readonly hashAlgorithm: typeof HASH_ALGORITHM;
  readonly options: BaselineOptions;
  readonly stats: BaselineStats;
  /** Entries sorted by `path` using byte order, so output is deterministic. */
  readonly entries: readonly BaselineEntry[];
  /** Entries that exist but could not be hashed, sorted by `path`. */
  readonly skipped: readonly SkippedEntry[];
  readonly signature?: BaselineSignature;
}

/** A baseline document before signing. */
export type UnsignedBaseline = Omit<Baseline, 'signature'>;

/** The result of scanning a directory tree. */
export interface ScanResult {
  readonly root: string;
  readonly options: BaselineOptions;
  readonly entries: readonly BaselineEntry[];
  readonly skipped: readonly SkippedEntry[];
  readonly stats: BaselineStats;
  readonly durationMs: number;
}

/** Progress notifications emitted while a scan runs. */
export interface ScanProgress {
  readonly filesHashed: number;
  readonly bytesHashed: number;
  readonly skipped: number;
  readonly currentPath: string;
}
