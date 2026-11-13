/**
 * Canonical JSON encoding.
 *
 * Signing a document means signing exactly one sequence of bytes. Two
 * encoders that disagree about key order or whitespace produce two different
 * signatures for the same data, so the keyed integrity tag is computed over
 * this encoding rather than over whatever `JSON.stringify` happens to emit
 * for a given object.
 *
 * The rules are deliberately narrow: object keys sorted by UTF-16 code unit,
 * no insignificant whitespace, arrays in their given order, and `undefined`
 * properties omitted. Values that JSON cannot represent exactly — `NaN`,
 * infinities, functions — are rejected rather than coerced.
 */

/** Serializes a value to its canonical JSON encoding. */
export function canonicalize(value: unknown): string {
  const encoded = encode(value);
  if (encoded === undefined) {
    throw new TypeError('Value cannot be canonicalized.');
  }
  return encoded;
}

function encode(value: unknown): string | undefined {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('Cannot canonicalize a non-finite number.');
      }
      // `-0` and `0` are the same JSON number; normalise so they sign alike.
      return JSON.stringify(value === 0 ? 0 : value);
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
      return undefined;
    case 'object':
      break;
    default:
      throw new TypeError(
        `Cannot canonicalize a value of type ${typeof value}.`,
      );
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => encode(item) ?? 'null');
    return `[${items.join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const parts: string[] = [];
  for (const key of keys) {
    const encoded = encode(record[key]);
    if (encoded === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(',')}}`;
}
