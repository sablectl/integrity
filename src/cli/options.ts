/**
 * Shared option definitions and resolution.
 *
 * `scan`, `verify` and `watch` must agree about what is being protected:
 * a verification run with different exclusions from the scan that produced
 * the baseline reports differences that are artefacts of the command line
 * rather than events on disk. Keeping one definition of these options, and
 * one place that merges them with the configuration file, is what keeps the
 * three commands consistent.
 *
 * Precedence is command line, then configuration file, then built-in
 * default — the ordinary rule, stated here because an integrity tool that
 * silently resolves options differently from what the operator expects is
 * worse than one that is merely inconvenient.
 */
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { OptionSpec, ParsedArgs } from './args.js';
import {
  booleanOption,
  integerOption,
  listOption,
  parseSize,
  stringOption,
} from './args.js';
import { CONFIG_FILE_NAME, loadConfig } from '../core/config.js';
import type { IntegrityConfig } from '../core/config.js';
import { DEFAULT_BASELINE_PATH } from '../core/baseline.js';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILE_SIZE_BYTES,
} from '../core/scan.js';
import { UsageError } from '../core/errors.js';
import { toPosix } from '../core/paths.js';
import { loadKeyFromEnvironment, loadKeyFromFile } from '../core/signature.js';
import type { SigningKey } from '../core/signature.js';

/** Options accepted by every command. */
export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  {
    name: 'help',
    short: 'h',
    type: 'boolean',
    description: 'Show help for this command.',
  },
  {
    name: 'color',
    type: 'boolean',
    negatable: true,
    description:
      'Force colour on or off. Colour is off when output is piped or NO_COLOR is set.',
  },
  {
    name: 'quiet',
    short: 'q',
    type: 'boolean',
    description: 'Suppress progress and informational output on stderr.',
  },
];

/** Options shared by the commands that walk the filesystem. */
export const SCAN_OPTIONS: readonly OptionSpec[] = [
  {
    name: 'baseline',
    short: 'b',
    type: 'string',
    placeholder: '<file>',
    description: `Baseline file. Defaults to <directory>/${DEFAULT_BASELINE_PATH}.`,
  },
  {
    name: 'config',
    short: 'c',
    type: 'string',
    placeholder: '<file>',
    description: `Configuration file. Defaults to <directory>/${CONFIG_FILE_NAME} when present.`,
  },
  {
    name: 'exclude',
    short: 'e',
    type: 'string[]',
    placeholder: '<pattern>',
    description:
      'Exclude paths matching a glob. Repeatable. Adds to the configured list.',
  },
  {
    name: 'follow-symlinks',
    type: 'boolean',
    description:
      'Follow symbolic links. Off by default; links are recorded by their target string.',
  },
  {
    name: 'one-file-system',
    type: 'boolean',
    description: 'Do not descend into directories on another filesystem.',
  },
  {
    name: 'max-file-size',
    type: 'string',
    placeholder: '<size>',
    description:
      'Refuse to hash files above this size, for example 20M. "off" removes the limit.',
  },
  {
    name: 'max-depth',
    type: 'number',
    placeholder: '<n>',
    description: 'Maximum directory depth below the root.',
  },
  {
    name: 'concurrency',
    short: 'j',
    type: 'number',
    placeholder: '<n>',
    description: 'Number of files hashed at the same time.',
  },
  {
    name: 'key-file',
    type: 'string',
    placeholder: '<file>',
    description: `Key file for baseline signing and verification. Falls back to $INTEGRITY_KEY.`,
  },
  {
    name: 'key-id',
    type: 'string',
    placeholder: '<label>',
    description: 'Non-secret label recorded alongside the signature.',
  },
];

export interface ResolvedScanSettings {
  readonly directory: string;
  readonly baselinePath: string;
  readonly exclude: readonly string[];
  readonly followSymlinks: boolean;
  readonly recordMetadata: boolean;
  readonly oneFileSystem: boolean;
  readonly maxFileSizeBytes: number | null;
  readonly maxDepth: number | null;
  readonly concurrency: number;
  readonly checkMetadata: boolean;
  readonly checkMtime: boolean;
  readonly debounceMs: number;
  readonly intervalSeconds: number;
  readonly config?: IntegrityConfig;
  readonly configPath?: string;
}

/** Merges command line, configuration file and defaults. */
export async function resolveScanSettings(
  parsed: ParsedArgs,
  cwd: string,
): Promise<ResolvedScanSettings> {
  if (parsed.positionals.length > 1) {
    throw new UsageError(
      `Expected at most one directory, got ${String(parsed.positionals.length)}.`,
    );
  }
  const directory = resolve(cwd, parsed.positionals[0] ?? '.');

  const explicitConfig = stringOption(parsed, 'config');
  const configPath = explicitConfig
    ? resolve(cwd, explicitConfig)
    : join(directory, CONFIG_FILE_NAME);
  const config = await loadConfig(configPath, explicitConfig !== undefined);

  const baselineOption = stringOption(parsed, 'baseline') ?? config?.baseline;
  const baselinePath = baselineOption
    ? resolve(
        isAbsolute(baselineOption)
          ? baselineOption
          : join(directory, baselineOption),
      )
    : join(directory, DEFAULT_BASELINE_PATH);

  const maxFileSizeRaw = stringOption(parsed, 'max-file-size');
  const maxFileSizeBytes =
    maxFileSizeRaw !== undefined
      ? parseSize(maxFileSizeRaw, 'max-file-size')
      : config?.maxFileSizeBytes !== undefined
        ? config.maxFileSizeBytes
        : DEFAULT_MAX_FILE_SIZE_BYTES;

  const maxDepthOption = integerOption(parsed, 'max-depth', {
    min: 0,
    max: 4096,
  });
  const maxDepth =
    maxDepthOption ??
    (config?.maxDepth !== undefined ? config.maxDepth : DEFAULT_MAX_DEPTH);

  const concurrency =
    integerOption(parsed, 'concurrency', { min: 1, max: 1024 }) ??
    config?.concurrency ??
    DEFAULT_CONCURRENCY;

  // A baseline stored inside the directory it describes would otherwise be
  // reported as an added file on the very next run, and its own contents
  // change every time it is rewritten. It is excluded implicitly, and the
  // documentation explains why keeping it outside the tree is better still.
  const implicitExclude: string[] = [];
  const baselineInside = relative(directory, baselinePath);
  if (
    baselineInside !== '' &&
    !baselineInside.startsWith('..') &&
    !isAbsolute(baselineInside)
  ) {
    implicitExclude.push(`/${toPosix(baselineInside)}`);
  }

  return {
    directory,
    baselinePath,
    exclude: [
      ...implicitExclude,
      ...(config?.exclude ?? []),
      ...listOption(parsed, 'exclude'),
    ],
    followSymlinks:
      booleanOption(parsed, 'follow-symlinks') ??
      config?.followSymlinks ??
      false,
    recordMetadata: config?.recordMetadata ?? true,
    oneFileSystem:
      booleanOption(parsed, 'one-file-system') ??
      config?.oneFileSystem ??
      false,
    maxFileSizeBytes,
    maxDepth,
    concurrency,
    checkMetadata:
      booleanOption(parsed, 'metadata') ?? config?.checkMetadata ?? true,
    checkMtime: booleanOption(parsed, 'mtime') ?? config?.checkMtime ?? false,
    debounceMs:
      integerOption(parsed, 'debounce', { min: 0, max: 60_000 }) ??
      config?.debounceMs ??
      250,
    intervalSeconds:
      integerOption(parsed, 'interval', { min: 0, max: 86_400 }) ??
      config?.intervalSeconds ??
      300,
    ...(config ? { config, configPath } : {}),
  };
}

/**
 * Resolves the signing key, if any. An explicit `--key-file` that cannot be
 * read is an error; the environment variable is optional.
 */
export async function resolveKey(
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<SigningKey | undefined> {
  const keyId = stringOption(parsed, 'key-id');
  const keyFile = stringOption(parsed, 'key-file');
  if (keyFile !== undefined) {
    return loadKeyFromFile(resolve(cwd, keyFile), keyId);
  }
  return loadKeyFromEnvironment(env, keyId);
}
