/**
 * Baseline documents: building, validating, reading and writing.
 *
 * A baseline on disk is untrusted input. It may have been truncated by a
 * full disk, hand-edited, produced by a newer release, or written by someone
 * hostile. Every field is therefore checked before use, and a baseline that
 * fails validation is rejected with a reason rather than partially accepted:
 * half a trusted reference state is worse than none, because it silently
 * stops protecting the files it dropped.
 *
 * Writes are atomic. The document is written to a temporary file in the same
 * directory, flushed to disk, and renamed into place, so a crash or a full
 * disk leaves either the old baseline or the new one, never a half-written
 * file that would make the next verification meaningless.
 */
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { BaselineError, IoError, describeError, errorCode } from './errors.js';
import { assertSafeRelativePath, comparePaths } from './paths.js';
import { BASELINE_SCHEMA_VERSION, HASH_ALGORITHM } from './types.js';
import type {
  Baseline,
  BaselineEntry,
  BaselineOptions,
  BaselineStats,
  EntryType,
  ScanResult,
  SkipReason,
  SkippedEntry,
  UnsignedBaseline,
} from './types.js';

/** Default location of a baseline relative to the directory being watched. */
export const DEFAULT_BASELINE_PATH = '.integrity/baseline.json';

/** Permissions applied to a written baseline: owner read/write only. */
export const BASELINE_FILE_MODE = 0o600;

/** Refuse to parse baselines larger than this, in bytes. */
export const MAX_BASELINE_BYTES = 512 * 1024 * 1024;

const SKIP_REASONS: readonly SkipReason[] = [
  'unreadable',
  'too-large',
  'symlink',
  'other-filesystem',
  'max-depth',
  'unsupported-type',
  'cycle',
];

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Builds an unsigned baseline document from a scan result. */
export function buildBaseline(
  scan: ScanResult,
  toolVersion: string,
  createdAt: Date = new Date(),
): UnsignedBaseline {
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    tool: { name: 'integrity', version: toolVersion },
    createdAt: createdAt.toISOString(),
    root: scan.root,
    hashAlgorithm: HASH_ALGORITHM,
    options: scan.options,
    stats: scan.stats,
    entries: scan.entries,
    skipped: scan.skipped,
  };
}

/** Serializes a baseline as indented JSON with a trailing newline. */
export function serializeBaseline(
  baseline: Baseline | UnsignedBaseline,
): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

export interface WriteBaselineOptions {
  /** Refuse to replace an existing file unless true. */
  readonly overwrite?: boolean;
  readonly mode?: number;
}

/**
 * Writes a baseline atomically.
 *
 * Replacing a trusted baseline is always an explicit act: without
 * `overwrite`, an existing file is left untouched and the caller is told.
 */
export async function writeBaseline(
  filePath: string,
  baseline: Baseline | UnsignedBaseline,
  options: WriteBaselineOptions = {},
): Promise<void> {
  const target = resolve(filePath);
  const directory = dirname(target);
  const mode = options.mode ?? BASELINE_FILE_MODE;

  await mkdir(directory, { recursive: true, mode: 0o700 }).catch(
    (error: unknown) => {
      throw new IoError(`Cannot create ${directory}: ${describeError(error)}`);
    },
  );

  if (options.overwrite !== true && (await exists(target))) {
    throw new IoError(
      `Refusing to overwrite the existing baseline at ${target}.`,
      ['Pass --force to replace it. Replacing a baseline is always explicit.'],
    );
  }

  const temporary = `${target}.tmp-${randomBytes(6).toString('hex')}`;
  const payload = serializeBaseline(baseline);
  try {
    // `wx` fails if the temporary name already exists, so a hostile symlink
    // planted at a predictable path cannot redirect the write.
    const handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      mode,
    );
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (error instanceof IoError) throw error;
    throw new IoError(
      `Cannot write baseline ${target}: ${describeError(error)}`,
    );
  }
}

/** Reads and validates a baseline from disk. */
export async function readBaseline(filePath: string): Promise<Baseline> {
  const target = resolve(filePath);
  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new BaselineError(`No baseline at ${target}.`, [
        'Create one with: integrity scan <directory>',
      ]);
    }
    throw new BaselineError(
      `Cannot read baseline ${target}: ${describeError(error)}`,
    );
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BASELINE_BYTES) {
    throw new BaselineError(
      `Baseline ${target} is implausibly large; refusing to parse.`,
    );
  }
  return parseBaseline(raw, target);
}

/** Parses a baseline from text and validates it. */
export function parseBaseline(text: string, origin = '<memory>'): Baseline {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new BaselineError(
      `Baseline ${origin} is not valid JSON: ${describeError(error)}`,
      [
        'A truncated or hand-edited baseline cannot be trusted. Re-create it from a known-good state.',
      ],
    );
  }
  return validateBaseline(data, origin);
}

/**
 * Validates an arbitrary value as a baseline document.
 *
 * Collects every problem it finds rather than stopping at the first, because
 * an operator fixing a damaged baseline benefits from the whole list.
 */
export function validateBaseline(data: unknown, origin = '<memory>'): Baseline {
  const problems: string[] = [];

  if (!isRecord(data)) {
    throw new BaselineError(`Baseline ${origin} is not an object.`);
  }

  const schemaVersion = data['schemaVersion'];
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    problems.push('schemaVersion must be an integer.');
  } else if (schemaVersion > BASELINE_SCHEMA_VERSION) {
    throw new BaselineError(
      `Baseline ${origin} uses schema version ${String(schemaVersion)}, newer than this release understands (${String(BASELINE_SCHEMA_VERSION)}).`,
      ['Upgrade integrity, or re-create the baseline with this version.'],
    );
  } else if (schemaVersion < 1) {
    problems.push(`Unsupported schema version ${String(schemaVersion)}.`);
  }

  const hashAlgorithm = data['hashAlgorithm'];
  if (hashAlgorithm !== HASH_ALGORITHM) {
    problems.push(`hashAlgorithm must be "${HASH_ALGORITHM}".`);
  }

  const createdAt = data['createdAt'];
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    problems.push('createdAt must be an ISO 8601 timestamp.');
  }

  const root = data['root'];
  if (typeof root !== 'string' || root === '') {
    problems.push('root must be a non-empty string.');
  }

  const tool = data['tool'];
  let toolRecord = { name: 'integrity', version: 'unknown' };
  if (
    !isRecord(tool) ||
    typeof tool['name'] !== 'string' ||
    typeof tool['version'] !== 'string'
  ) {
    problems.push('tool must be an object with name and version strings.');
  } else {
    toolRecord = { name: tool['name'], version: tool['version'] };
  }

  const options = validateOptions(data['options'], problems);
  const entries = validateEntries(data['entries'], problems);
  const skipped = validateSkipped(data['skipped'], problems);
  const stats = validateStats(data['stats'], problems);
  const signature = validateSignature(data['signature'], problems);

  if (problems.length > 0) {
    throw new BaselineError(
      `Baseline ${origin} failed schema validation.`,
      problems,
    );
  }

  return {
    schemaVersion: schemaVersion as number,
    tool: toolRecord,
    createdAt: createdAt as string,
    root: root as string,
    hashAlgorithm: HASH_ALGORITHM,
    options,
    stats,
    entries,
    skipped,
    ...(signature ? { signature } : {}),
  };
}

function validateOptions(value: unknown, problems: string[]): BaselineOptions {
  if (!isRecord(value)) {
    problems.push('options must be an object.');
    return {
      exclude: [],
      followSymlinks: false,
      recordMetadata: false,
      oneFileSystem: false,
      maxFileSizeBytes: null,
      maxDepth: null,
    };
  }
  const exclude = value['exclude'];
  const excludeList: string[] = [];
  if (!Array.isArray(exclude)) {
    problems.push('options.exclude must be an array of strings.');
  } else {
    for (const pattern of exclude) {
      if (typeof pattern !== 'string') {
        problems.push('options.exclude must contain only strings.');
        break;
      }
      excludeList.push(pattern);
    }
  }
  return {
    exclude: excludeList,
    followSymlinks: readBoolean(
      value['followSymlinks'],
      'options.followSymlinks',
      problems,
    ),
    recordMetadata: readBoolean(
      value['recordMetadata'],
      'options.recordMetadata',
      problems,
    ),
    oneFileSystem: readBoolean(
      value['oneFileSystem'],
      'options.oneFileSystem',
      problems,
    ),
    maxFileSizeBytes: readNullableCount(
      value['maxFileSizeBytes'],
      'options.maxFileSizeBytes',
      problems,
    ),
    maxDepth: readNullableCount(
      value['maxDepth'],
      'options.maxDepth',
      problems,
    ),
  };
}

function validateEntries(value: unknown, problems: string[]): BaselineEntry[] {
  if (!Array.isArray(value)) {
    problems.push('entries must be an array.');
    return [];
  }
  const entries: BaselineEntry[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const entry = validateEntry(raw, index, problems);
    if (!entry) continue;
    if (seen.has(entry.path)) {
      problems.push(`entries[${String(index)}]: duplicate path ${entry.path}.`);
      continue;
    }
    seen.add(entry.path);
    entries.push(entry);
  }
  entries.sort((left, right) => comparePaths(left.path, right.path));
  return entries;
}

function validateEntry(
  raw: unknown,
  index: number,
  problems: string[],
): BaselineEntry | undefined {
  const where = `entries[${String(index)}]`;
  if (!isRecord(raw)) {
    problems.push(`${where} must be an object.`);
    return undefined;
  }
  const path = raw['path'];
  if (typeof path !== 'string') {
    problems.push(`${where}.path must be a string.`);
    return undefined;
  }
  try {
    assertSafeRelativePath(path);
  } catch (error) {
    problems.push(`${where}: ${describeError(error)}`);
    return undefined;
  }

  const type = raw['type'];
  if (type !== 'file' && type !== 'symlink') {
    problems.push(`${where}.type must be "file" or "symlink".`);
    return undefined;
  }

  const sha256 = raw['sha256'];
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    problems.push(`${where}.sha256 must be 64 lowercase hex characters.`);
    return undefined;
  }

  const size = raw['size'];
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
    problems.push(`${where}.size must be a non-negative integer.`);
    return undefined;
  }

  const mtimeMs = raw['mtimeMs'];
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) {
    problems.push(`${where}.mtimeMs must be a number.`);
    return undefined;
  }

  const entryType: EntryType = type;
  const target = raw['target'];
  if (entryType === 'symlink' && typeof target !== 'string') {
    problems.push(`${where}.target must be a string for a symlink entry.`);
    return undefined;
  }

  return {
    path,
    type: entryType,
    size,
    sha256,
    mtimeMs,
    ...(typeof raw['mode'] === 'number' ? { mode: raw['mode'] } : {}),
    ...(typeof raw['uid'] === 'number' ? { uid: raw['uid'] } : {}),
    ...(typeof raw['gid'] === 'number' ? { gid: raw['gid'] } : {}),
    ...(typeof target === 'string' ? { target } : {}),
  };
}

function validateSkipped(value: unknown, problems: string[]): SkippedEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push('skipped must be an array.');
    return [];
  }
  const skipped: SkippedEntry[] = [];
  for (const [index, raw] of value.entries()) {
    const where = `skipped[${String(index)}]`;
    if (!isRecord(raw)) {
      problems.push(`${where} must be an object.`);
      continue;
    }
    const path = raw['path'];
    const reason = raw['reason'];
    const message = raw['message'];
    if (typeof path !== 'string') {
      problems.push(`${where}.path must be a string.`);
      continue;
    }
    if (
      typeof reason !== 'string' ||
      !SKIP_REASONS.includes(reason as SkipReason)
    ) {
      problems.push(`${where}.reason is not a known skip reason.`);
      continue;
    }
    skipped.push({
      path,
      reason: reason as SkipReason,
      message: typeof message === 'string' ? message : '',
    });
  }
  skipped.sort((left, right) => comparePaths(left.path, right.path));
  return skipped;
}

function validateStats(value: unknown, problems: string[]): BaselineStats {
  const empty: BaselineStats = {
    files: 0,
    symlinks: 0,
    directories: 0,
    totalBytes: 0,
    skipped: 0,
  };
  if (!isRecord(value)) {
    problems.push('stats must be an object.');
    return empty;
  }
  return {
    files: readCount(value['files'], 'stats.files', problems),
    symlinks: readCount(value['symlinks'], 'stats.symlinks', problems),
    directories: readCount(value['directories'], 'stats.directories', problems),
    totalBytes: readCount(value['totalBytes'], 'stats.totalBytes', problems),
    skipped: readCount(value['skipped'], 'stats.skipped', problems),
  };
}

function validateSignature(
  value: unknown,
  problems: string[],
): Baseline['signature'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    problems.push('signature must be an object when present.');
    return undefined;
  }
  const algorithm = value['algorithm'];
  const tag = value['value'];
  if (algorithm !== 'hmac-sha256') {
    problems.push('signature.algorithm must be "hmac-sha256".');
    return undefined;
  }
  if (typeof tag !== 'string' || !SHA256_PATTERN.test(tag)) {
    problems.push('signature.value must be 64 lowercase hex characters.');
    return undefined;
  }
  const keyId = value['keyId'];
  if (keyId !== undefined && typeof keyId !== 'string') {
    problems.push('signature.keyId must be a string when present.');
    return undefined;
  }
  return {
    algorithm: 'hmac-sha256',
    ...(typeof keyId === 'string' ? { keyId } : {}),
    value: tag,
  };
}

function readBoolean(
  value: unknown,
  where: string,
  problems: string[],
): boolean {
  if (typeof value !== 'boolean') {
    problems.push(`${where} must be a boolean.`);
    return false;
  }
  return value;
}

function readCount(value: unknown, where: string, problems: string[]): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    problems.push(`${where} must be a non-negative integer.`);
    return 0;
  }
  return value;
}

function readNullableCount(
  value: unknown,
  where: string,
  problems: string[],
): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    problems.push(`${where} must be a non-negative integer or null.`);
    return null;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    const handle = await open(filePath, 'r');
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Flushes a directory entry so the rename itself survives a crash. Not every
 * platform supports opening a directory for this purpose; where it is not
 * supported the rename is still atomic, only its durability is weaker, so
 * the failure is ignored rather than aborting a successful write.
 */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Intentionally ignored; see above.
  }
}
