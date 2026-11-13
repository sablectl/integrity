/**
 * Argument parsing.
 *
 * A small declarative parser rather than a framework: the option set is
 * modest, and the behaviour that matters here — rejecting unknown options
 * instead of ignoring them — is easier to guarantee in forty lines than to
 * configure in a dependency.
 *
 * An unrecognised option is always an error. A tool whose job is to answer
 * "did anything change" must never quietly ignore `--exlude` and then report
 * a clean result it was never asked for.
 */
import { UsageError } from '../core/errors.js';

export type OptionType = 'boolean' | 'string' | 'number' | 'string[]';

export interface OptionSpec {
  readonly name: string;
  readonly type: OptionType;
  readonly short?: string;
  readonly description: string;
  readonly placeholder?: string;
  /** Allow `--no-<name>` to set the flag false. */
  readonly negatable?: boolean;
}

export type OptionValue = boolean | string | number | readonly string[];

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, OptionValue>;
}

/** Parses `argv` against `specs`. */
export function parseArgs(
  argv: readonly string[],
  specs: readonly OptionSpec[],
): ParsedArgs {
  const byName = new Map<string, OptionSpec>();
  const byShort = new Map<string, OptionSpec>();
  for (const spec of specs) {
    byName.set(spec.name, spec);
    if (spec.short !== undefined) byShort.set(spec.short, spec);
  }

  const positionals: string[] = [];
  const options = new Map<string, OptionValue>();
  let onlyPositionals = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';

    if (onlyPositionals) {
      positionals.push(argument);
      continue;
    }
    if (argument === '--') {
      onlyPositionals = true;
      continue;
    }
    if (argument === '-' || !argument.startsWith('-')) {
      positionals.push(argument);
      continue;
    }

    let name: string;
    let inlineValue: string | undefined;
    if (argument.startsWith('--')) {
      const body = argument.slice(2);
      const equals = body.indexOf('=');
      name = equals === -1 ? body : body.slice(0, equals);
      inlineValue = equals === -1 ? undefined : body.slice(equals + 1);
    } else {
      const body = argument.slice(1);
      if (body.length !== 1) {
        throw new UsageError(`Unknown option: ${argument}`, [
          'Short options take one letter at a time, for example -q -j.',
        ]);
      }
      const spec = byShort.get(body);
      if (!spec) throw new UsageError(`Unknown option: ${argument}`);
      name = spec.name;
    }

    let spec = byName.get(name);
    let negated = false;
    if (!spec && name.startsWith('no-')) {
      const positive = byName.get(name.slice(3));
      if (positive?.negatable === true && positive.type === 'boolean') {
        spec = positive;
        negated = true;
        name = positive.name;
      }
    }
    if (!spec) {
      throw new UsageError(`Unknown option: --${name}`, [
        'Run with --help to see the options this command accepts.',
      ]);
    }

    if (spec.type === 'boolean') {
      if (inlineValue !== undefined) {
        throw new UsageError(`Option --${name} does not take a value.`);
      }
      options.set(name, !negated);
      continue;
    }

    let raw = inlineValue;
    if (raw === undefined) {
      const next = argv[index + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        throw new UsageError(`Option --${name} requires a value.`);
      }
      raw = next;
      index += 1;
    }

    if (spec.type === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new UsageError(`Option --${name} requires a number, got: ${raw}`);
      }
      options.set(name, value);
      continue;
    }

    if (spec.type === 'string[]') {
      const previous = options.get(name);
      const list: string[] = Array.isArray(previous)
        ? [...(previous as string[])]
        : [];
      list.push(raw);
      options.set(name, list);
      continue;
    }

    options.set(name, raw);
  }

  return { positionals, options };
}

/** Reads a boolean option, or `undefined` when it was not given. */
export function booleanOption(
  parsed: ParsedArgs,
  name: string,
): boolean | undefined {
  const value = parsed.options.get(name);
  return typeof value === 'boolean' ? value : undefined;
}

/** Reads a string option. */
export function stringOption(
  parsed: ParsedArgs,
  name: string,
): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

/** Reads a repeated string option as a list. */
export function listOption(
  parsed: ParsedArgs,
  name: string,
): readonly string[] {
  const value = parsed.options.get(name);
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

/**
 * Reads a non-negative integer option. Rejects fractions and negatives
 * rather than truncating them: a silently rounded `--concurrency 0.5` is a
 * worse outcome than an error message.
 */
export function integerOption(
  parsed: ParsedArgs,
  name: string,
  {
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
  }: { min?: number; max?: number } = {},
): number | undefined {
  const value = parsed.options.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new UsageError(`Option --${name} requires a whole number.`);
  }
  if (value < min || value > max) {
    throw new UsageError(
      `Option --${name} must be between ${String(min)} and ${String(max)}.`,
    );
  }
  return value;
}

/**
 * Parses a byte size such as `10`, `512K`, `20M`, `2G`. Plain numbers are
 * bytes; `off` disables the limit.
 */
export function parseSize(raw: string, optionName: string): number | null {
  const text = raw.trim().toLowerCase();
  if (text === 'off' || text === 'none' || text === 'unlimited') return null;
  const match = /^(\d+)(b|k|kb|kib|m|mb|mib|g|gb|gib)?$/.exec(text);
  if (!match) {
    throw new UsageError(
      `Option --${optionName} must be a size such as 512K, 20M or 2G, or "off".`,
    );
  }
  const amount = Number(match[1]);
  const factors: Record<string, number> = {
    b: 1,
    k: 1024,
    kb: 1024,
    kib: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
  };
  const factor = match[2] === undefined ? 1 : (factors[match[2]] ?? 1);
  const bytes = amount * factor;
  if (!Number.isSafeInteger(bytes)) {
    throw new UsageError(`Option --${optionName} is too large.`);
  }
  return bytes;
}
