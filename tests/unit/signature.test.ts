import { randomBytes } from 'node:crypto';
import { describe, expect, it, afterEach } from 'vitest';
import {
  KEY_ENV_VAR,
  computeTag,
  loadKeyFromEnvironment,
  loadKeyFromFile,
  signBaseline,
  verifySignature,
} from '../../src/core/signature.js';
import type { SigningKey } from '../../src/core/signature.js';
import { canonicalize } from '../../src/core/canonical.js';
import { buildBaseline } from '../../src/core/baseline.js';
import { scanDirectory } from '../../src/core/scan.js';
import { BaselineError, UsageError } from '../../src/core/errors.js';
import { makeTempTree } from '../helpers/tempdir.js';
import type { TempTree } from '../helpers/tempdir.js';

let tree: TempTree | undefined;
afterEach(async () => {
  await tree?.cleanup();
  tree = undefined;
});

const key: SigningKey = {
  material: Buffer.from('0123456789abcdef0123456789abcdef'),
  origin: 'test key',
};
const otherKey: SigningKey = {
  material: Buffer.from('fedcba9876543210fedcba9876543210'),
  origin: 'other test key',
};

async function baselineFixture(): Promise<ReturnType<typeof buildBaseline>> {
  tree = await makeTempTree();
  await tree.file('a.txt', 'alpha');
  const scan = await scanDirectory({ root: tree.root });
  return buildBaseline(scan, '1.0.0');
}

describe('canonical encoding', () => {
  it('orders keys so the same data always encodes identically', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ a: 2, b: 1 })).toBe(canonicalize({ b: 1, a: 2 }));
  });

  it('omits undefined properties and keeps array order', () => {
    expect(canonicalize({ a: undefined, b: [3, 1, 2] })).toBe('{"b":[3,1,2]}');
  });

  it('refuses values JSON cannot represent exactly', () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow(
      TypeError,
    );
  });
});

describe('keyed baseline integrity', () => {
  it('verifies a baseline signed with the same key', async () => {
    const signed = signBaseline(await baselineFixture(), key);

    expect(verifySignature(signed, key)).toEqual({ status: 'valid' });
  });

  it('rejects a baseline whose contents were altered after signing', async () => {
    const signed = signBaseline(await baselineFixture(), key);
    const tampered = {
      ...signed,
      entries: [{ ...signed.entries[0]!, sha256: '0'.repeat(64) }],
    };

    expect(verifySignature(tampered, key).status).toBe('invalid');
  });

  it('rejects a baseline signed with a different key', async () => {
    const signed = signBaseline(await baselineFixture(), key);

    expect(verifySignature(signed, otherKey).status).toBe('invalid');
  });

  it('reports a signed baseline as unverified when no key is supplied', async () => {
    const signed = signBaseline(await baselineFixture(), key);

    const state = verifySignature(signed, undefined);

    expect(state.status).toBe('unverified');
  });

  it('treats a signature stripped from a signed deployment as tampering', async () => {
    const unsigned = await baselineFixture();

    expect(verifySignature(unsigned, key).status).toBe('invalid');
  });

  it('reports an unsigned baseline plainly when no key is in use', async () => {
    const unsigned = await baselineFixture();

    expect(verifySignature(unsigned, undefined)).toEqual({
      status: 'unsigned',
    });
  });

  it('rejects an unknown signature algorithm', async () => {
    const signed = signBaseline(await baselineFixture(), key);
    const odd = {
      ...signed,
      signature: {
        algorithm: 'crc32' as unknown as 'hmac-sha256',
        value: signed.signature?.value ?? '',
      },
    };

    expect(verifySignature(odd, key).status).toBe('invalid');
  });

  it('records a key identifier without ever recording key material', async () => {
    const labelled: SigningKey = { ...key, keyId: 'prod-2025' };

    const signed = signBaseline(await baselineFixture(), labelled);

    expect(signed.signature?.keyId).toBe('prod-2025');
    expect(JSON.stringify(signed)).not.toContain(key.material.toString('utf8'));
  });

  it('produces the same tag regardless of property order', async () => {
    const original = await baselineFixture();
    // The same data with its top-level properties written in a different
    // order: the canonical encoding must make the two indistinguishable.
    const reordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(original).reverse())),
    ) as typeof original;

    expect(computeTag(reordered, key)).toBe(computeTag(original, key));
  });
});

describe('key loading', () => {
  it('reads a key from a file and ignores a trailing newline', async () => {
    tree = await makeTempTree();
    const material = randomBytes(32).toString('base64');
    const path = await tree.file('integrity.key', `${material}\n`);

    const loaded = await loadKeyFromFile(path);

    expect(loaded.material.toString('utf8')).toBe(material);
  });

  it('refuses a key that is too short to be useful', async () => {
    tree = await makeTempTree();
    const path = await tree.file('weak.key', 'short');

    await expect(loadKeyFromFile(path)).rejects.toBeInstanceOf(BaselineError);
  });

  it('reports a missing key file as a usage error', async () => {
    tree = await makeTempTree();

    await expect(
      loadKeyFromFile(tree.path('absent.key')),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('reads a key from the environment when present', () => {
    const material = randomBytes(32).toString('base64');

    expect(
      loadKeyFromEnvironment({ [KEY_ENV_VAR]: material })?.material.toString(),
    ).toBe(material);
    expect(loadKeyFromEnvironment({})).toBeUndefined();
    expect(loadKeyFromEnvironment({ [KEY_ENV_VAR]: '' })).toBeUndefined();
  });
});
