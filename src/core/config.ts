/**
 * Configuration file handling.
 *
 * A configuration file records the scan settings for a directory so that
 * `integrity scan` and `integrity verify` do not have to be given the same
 * long list of exclusions every time — and, more importantly, so that they
 * cannot accidentally be given *different* ones, which would turn an
 * exclusion mismatch into a wall of phantom findings.
 *
 * The file is plain JSON, validated field by field. Unknown keys are
 * reported rather than ignored: a typo in a configuration file that silently
 * disables an exclusion is a security problem, not a cosmetic one.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { UsageError, describeError, errorCode } from './errors.js';
import { compilePattern } from './exclude.js';

/** Conventional configuration file name. */
export const CONFIG_FILE_NAME = 'integrity.config.json';

export interface IntegrityConfig {
  readonly baseline?: string;
  readonly exclude?: readonly string[];
  readonly followSymlinks?: boolean;
  readonly recordMetadata?: boolean;
  readonly oneFileSystem?: boolean;
  readonly maxFileSizeBytes?: number | null;
  readonly maxDepth?: number | null;
  readonly concurrency?: number;
  readonly checkMetadata?: boolean;
  readonly checkMtime?: boolean;
  readonly debounceMs?: number;
  readonly intervalSeconds?: number;
}

const KNOWN_KEYS: readonly string[] = [
  '$schema',
  'baseline',
  'exclude',
  'followSymlinks',
  'recordMetadata',
  'oneFileSystem',
  'maxFileSizeBytes',
  'maxDepth',
  'concurrency',
  'checkMetadata',
  'checkMtime',
  'debounceMs',
  'intervalSeconds',
];

/** The configuration written by `integrity init`. */
export const DEFAULT_CONFIG: IntegrityConfig = {
  baseline: '.integrity/baseline.json',
  exclude: ['.integrity/', '.git/', 'node_modules/', '*.log', '*.tmp'],
  followSymlinks: false,
  recordMetadata: true,
  oneFileSystem: false,
  maxFileSizeBytes: 536_870_912,
  maxDepth: 64,
  concurrency: 8,
  checkMetadata: true,
  checkMtime: false,
  debounceMs: 250,
  intervalSeconds: 300,
};

/**
 * Loads a configuration file. Returns `undefined` when the file does not
 * exist and `required` is false, so a missing optional config is not an
 * error but an unreadable or malformed one always is.
 */
export async function loadConfig(
  filePath: string,
  required: boolean,
): Promise<IntegrityConfig | undefined> {
  const target = resolve(filePath);
  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT' && !required) return undefined;
    throw new UsageError(
      `Cannot read configuration ${target}: ${describeError(error)}`,
    );
  }
  return parseConfig(raw, target);
}

/** Parses and validates configuration text. */
export function parseConfig(
  text: string,
  origin = '<memory>',
): IntegrityConfig {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new UsageError(
      `Configuration ${origin} is not valid JSON: ${describeError(error)}`,
    );
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new UsageError(`Configuration ${origin} must be a JSON object.`);
  }
  const record = data as Record<string, unknown>;

  const problems: string[] = [];
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.includes(key)) problems.push(`Unknown option: ${key}`);
  }

  const config: {
    -readonly [K in keyof IntegrityConfig]: IntegrityConfig[K];
  } = {};

  if ('baseline' in record) {
    const value = record['baseline'];
    if (typeof value !== 'string' || value === '') {
      problems.push('baseline must be a non-empty string.');
    } else {
      config.baseline = value;
    }
  }

  if ('exclude' in record) {
    const value = record['exclude'];
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== 'string')
    ) {
      problems.push('exclude must be an array of strings.');
    } else {
      const patterns = value as string[];
      for (const pattern of patterns) {
        try {
          compilePattern(pattern);
        } catch (error) {
          problems.push(describeError(error));
        }
      }
      config.exclude = patterns;
    }
  }

  for (const key of [
    'followSymlinks',
    'recordMetadata',
    'oneFileSystem',
    'checkMetadata',
    'checkMtime',
  ] as const) {
    if (!(key in record)) continue;
    const value = record[key];
    if (typeof value !== 'boolean') {
      problems.push(`${key} must be a boolean.`);
      continue;
    }
    config[key] = value;
  }

  for (const key of ['maxFileSizeBytes', 'maxDepth'] as const) {
    if (!(key in record)) continue;
    const value = record[key];
    if (value === null) {
      config[key] = null;
      continue;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      problems.push(`${key} must be a non-negative integer or null.`);
      continue;
    }
    config[key] = value;
  }

  for (const key of ['concurrency', 'debounceMs', 'intervalSeconds'] as const) {
    if (!(key in record)) continue;
    const value = record[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      problems.push(`${key} must be a non-negative integer.`);
      continue;
    }
    config[key] = value;
  }

  if (problems.length > 0) {
    throw new UsageError(`Configuration ${origin} is not valid.`, problems);
  }
  return config;
}

/** Renders the default configuration as a file. */
export function serializeConfig(config: IntegrityConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
