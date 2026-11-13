/**
 * Keyed baseline integrity.
 *
 * A SHA-256 hash of a file proves nothing about authenticity on its own: an
 * attacker who can rewrite a monitored file can usually rewrite the baseline
 * next to it and recompute the hashes. What closes that gap is a secret the
 * attacker does not have.
 *
 * `integrity` therefore supports an optional HMAC-SHA-256 tag over the
 * canonical encoding of the baseline body. With the key held somewhere the
 * attacker cannot reach — a removable device, a secrets manager, another
 * host — a tampered baseline fails verification instead of quietly becoming
 * the new truth. Without a key, the baseline is an accident detector, not an
 * authenticity control, and the tool says so.
 *
 * Comparison uses `timingSafeEqual`, and the key is never written into the
 * baseline, the report, the logs or any error message.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalize } from './canonical.js';
import { BaselineError, UsageError, describeError } from './errors.js';
import type { Baseline, BaselineSignature, UnsignedBaseline } from './types.js';

/** Environment variable read when no key file is given. */
export const KEY_ENV_VAR = 'INTEGRITY_KEY';

/** Shortest key accepted, in bytes. */
export const MIN_KEY_BYTES = 16;

export interface SigningKey {
  readonly material: Buffer;
  /** Where the key came from, for messages. Never contains key material. */
  readonly origin: string;
  readonly keyId?: string;
}

export type SignatureState =
  | { readonly status: 'unsigned' }
  | { readonly status: 'unverified'; readonly reason: string }
  | { readonly status: 'valid' }
  | { readonly status: 'invalid'; readonly reason: string };

/** Loads a key from a file, trimming a single trailing newline. */
export async function loadKeyFromFile(
  filePath: string,
  keyId?: string,
): Promise<SigningKey> {
  let raw: Buffer;
  try {
    raw = await readFile(filePath);
  } catch (error) {
    throw new UsageError(
      `Cannot read key file ${filePath}: ${describeError(error)}`,
    );
  }
  const material = stripTrailingNewline(raw);
  assertKeyLength(material, `key file ${filePath}`);
  return {
    material,
    origin: `key file ${filePath}`,
    ...(keyId ? { keyId } : {}),
  };
}

/** Reads a key from the environment, when present. */
export function loadKeyFromEnvironment(
  environment: NodeJS.ProcessEnv,
  keyId?: string,
): SigningKey | undefined {
  const value = environment[KEY_ENV_VAR];
  if (value === undefined || value === '') return undefined;
  const material = Buffer.from(value, 'utf8');
  assertKeyLength(material, `environment variable ${KEY_ENV_VAR}`);
  return {
    material,
    origin: `environment variable ${KEY_ENV_VAR}`,
    ...(keyId ? { keyId } : {}),
  };
}

/** Computes the HMAC tag over the canonical encoding of a baseline body. */
export function computeTag(
  baseline: UnsignedBaseline,
  key: SigningKey,
): string {
  const body = canonicalize(stripSignature(baseline));
  return createHmac('sha256', key.material).update(body, 'utf8').digest('hex');
}

/** Returns a copy of `baseline` carrying a keyed integrity tag. */
export function signBaseline(
  baseline: UnsignedBaseline,
  key: SigningKey,
): Baseline {
  const signature: BaselineSignature = {
    algorithm: 'hmac-sha256',
    ...(key.keyId ? { keyId: key.keyId } : {}),
    value: computeTag(baseline, key),
  };
  return { ...baseline, signature };
}

/**
 * Checks a baseline's keyed integrity tag.
 *
 * `undefined` key means the caller did not supply one: a signed baseline is
 * then reported as unverified rather than valid, because "we did not check"
 * and "we checked and it was fine" must never look the same.
 */
export function verifySignature(
  baseline: Baseline,
  key: SigningKey | undefined,
): SignatureState {
  const signature = baseline.signature;
  if (!signature) {
    if (key) {
      return {
        status: 'invalid',
        reason:
          'A key was supplied but this baseline carries no signature. It may have been replaced with an unsigned copy.',
      };
    }
    return { status: 'unsigned' };
  }
  if (signature.algorithm !== 'hmac-sha256') {
    return {
      status: 'invalid',
      reason: `Unsupported signature algorithm: ${String(signature.algorithm)}`,
    };
  }
  if (!key) {
    return {
      status: 'unverified',
      reason:
        'The baseline is signed but no key was supplied, so it was not checked.',
    };
  }

  const expected = computeTag(stripSignature(baseline), key);
  if (!equalHex(expected, signature.value)) {
    return {
      status: 'invalid',
      reason:
        'Signature does not match. The baseline has been modified or a different key was used.',
    };
  }
  return { status: 'valid' };
}

function stripSignature(
  baseline: UnsignedBaseline | Baseline,
): UnsignedBaseline {
  const copy: Record<string, unknown> = { ...baseline };
  delete copy['signature'];
  return copy as unknown as UnsignedBaseline;
}

function equalHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]+$/.test(right) || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function stripTrailingNewline(raw: Buffer): Buffer {
  let end = raw.byteLength;
  if (end > 0 && raw[end - 1] === 0x0a) end -= 1;
  if (end > 0 && raw[end - 1] === 0x0d) end -= 1;
  return raw.subarray(0, end);
}

function assertKeyLength(material: Buffer, origin: string): void {
  if (material.byteLength < MIN_KEY_BYTES) {
    throw new BaselineError(
      `Key from ${origin} is too short: ${String(material.byteLength)} bytes, minimum ${String(MIN_KEY_BYTES)}.`,
      ['Generate one with: head -c 32 /dev/urandom | base64 > integrity.key'],
    );
  }
}
