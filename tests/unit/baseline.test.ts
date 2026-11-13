import { readFile, stat, writeFile } from 'node:fs/promises';
import { describe, expect, it, afterEach } from 'vitest';
import {
  BASELINE_FILE_MODE,
  buildBaseline,
  parseBaseline,
  readBaseline,
  serializeBaseline,
  validateBaseline,
  writeBaseline,
} from '../../src/core/baseline.js';
import { scanDirectory } from '../../src/core/scan.js';
import { BaselineError, IoError } from '../../src/core/errors.js';
import { BASELINE_SCHEMA_VERSION } from '../../src/core/types.js';
import { makeTempTree } from '../helpers/tempdir.js';
import type { TempTree } from '../helpers/tempdir.js';

let tree: TempTree | undefined;
afterEach(async () => {
  await tree?.cleanup();
  tree = undefined;
});

/**
 * Asserts that validation fails and that one of the reported problems
 * matches. Problems are collected in `details`, so the test reads them the
 * way an operator fixing a damaged baseline would.
 */
function expectProblem(act: () => unknown, pattern: RegExp): void {
  let captured: unknown;
  expect(act).toThrow(BaselineError);
  try {
    act();
  } catch (error) {
    captured = error;
  }
  const details = (captured as BaselineError).details.join('\n');
  expect(details).toMatch(pattern);
}

async function sampleBaseline(): Promise<{
  tree: TempTree;
  document: ReturnType<typeof buildBaseline>;
}> {
  const fixture = await makeTempTree();
  await fixture.file('a.txt', 'alpha');
  await fixture.file('dir/b.txt', 'beta');
  const scan = await scanDirectory({ root: fixture.root });
  return { tree: fixture, document: buildBaseline(scan, '1.0.0') };
}

describe('building and writing baselines', () => {
  it('records the schema version, algorithm and options', async () => {
    const sample = await sampleBaseline();
    tree = sample.tree;

    expect(sample.document.schemaVersion).toBe(BASELINE_SCHEMA_VERSION);
    expect(sample.document.hashAlgorithm).toBe('sha256');
    expect(sample.document.tool).toEqual({
      name: 'integrity',
      version: '1.0.0',
    });
    expect(sample.document.options.followSymlinks).toBe(false);
  });

  it('writes with owner-only permissions', async () => {
    const sample = await sampleBaseline();
    tree = sample.tree;
    const target = tree.path('out/baseline.json');

    await writeBaseline(target, sample.document);

    const stats = await stat(target);
    expect(stats.mode & 0o777).toBe(BASELINE_FILE_MODE);
  });

  it('refuses to replace an existing baseline without permission', async () => {
    const sample = await sampleBaseline();
    tree = sample.tree;
    const target = tree.path('baseline.json');
    await writeBaseline(target, sample.document);

    await expect(writeBaseline(target, sample.document)).rejects.toBeInstanceOf(
      IoError,
    );
  });

  it('replaces the baseline when overwriting is explicit', async () => {
    const sample = await sampleBaseline();
    tree = sample.tree;
    const target = tree.path('baseline.json');
    await writeBaseline(target, sample.document);

    await expect(
      writeBaseline(target, sample.document, { overwrite: true }),
    ).resolves.toBeUndefined();
  });

  it('leaves no temporary files behind', async () => {
    const sample = await sampleBaseline();
    tree = sample.tree;
    await writeBaseline(tree.path('out/baseline.json'), sample.document);

    const after = await scanDirectory({ root: tree.path('out') });
    expect(after.entries.map((entry) => entry.path)).toEqual(['baseline.json']);
  });

  it('round-trips through serialization', async () => {
    const sample = await sampleBaseline();
    tree = sample.tree;

    const parsed = parseBaseline(serializeBaseline(sample.document));

    expect(parsed.entries).toEqual(sample.document.entries);
    expect(parsed.stats).toEqual(sample.document.stats);
  });
});

describe('reading untrusted baselines', () => {
  it('rejects a truncated file', async () => {
    tree = await makeTempTree();
    const target = await tree.file(
      'baseline.json',
      '{"schemaVersion": 1, "entr',
    );

    await expect(readBaseline(target)).rejects.toBeInstanceOf(BaselineError);
  });

  it('rejects a baseline that is not an object', () => {
    expect(() => parseBaseline('[]')).toThrow(BaselineError);
    expect(() => parseBaseline('"text"')).toThrow(BaselineError);
  });

  it('reports a missing baseline with guidance', async () => {
    tree = await makeTempTree();

    await expect(readBaseline(tree.path('nope.json'))).rejects.toThrow(
      /No baseline at/,
    );
  });

  it('refuses a schema version from a newer release', () => {
    expect(() =>
      validateBaseline({ schemaVersion: BASELINE_SCHEMA_VERSION + 1 }),
    ).toThrow(/newer than this release understands/);
  });

  it('collects every schema problem rather than stopping at the first', () => {
    let captured: BaselineError | undefined;
    try {
      validateBaseline({
        schemaVersion: 1,
        hashAlgorithm: 'md5',
        createdAt: 'not-a-date',
        root: '',
        tool: {},
        options: {},
        stats: {},
        entries: {},
      });
    } catch (error) {
      captured = error as BaselineError;
    }

    expect(captured).toBeInstanceOf(BaselineError);
    expect(captured?.details.length).toBeGreaterThan(3);
  });

  it('rejects an entry whose path escapes the root', async () => {
    const sample = await sampleBaseline();
    tree = sample.tree;
    const hostile = {
      ...sample.document,
      entries: [{ ...sample.document.entries[0], path: '../../etc/shadow' }],
    };

    expectProblem(
      () => validateBaseline(JSON.parse(JSON.stringify(hostile))),
      /escapes the root/,
    );
  });

  it('rejects an absolute entry path', async () => {
    const sample = await sampleBaseline();
    tree = sample.tree;
    const hostile = {
      ...sample.document,
      entries: [{ ...sample.document.entries[0], path: '/etc/shadow' }],
    };

    expectProblem(
      () => validateBaseline(JSON.parse(JSON.stringify(hostile))),
      /must be relative/,
    );
  });

  it('rejects a digest that is not 64 hex characters', async () => {
    const sample = await sampleBaseline();
    tree = sample.tree;
    const broken = {
      ...sample.document,
      entries: [{ ...sample.document.entries[0], sha256: 'deadbeef' }],
    };

    expectProblem(
      () => validateBaseline(JSON.parse(JSON.stringify(broken))),
      /64 lowercase hex/,
    );
  });

  it('rejects duplicate entry paths', async () => {
    const sample = await sampleBaseline();
    tree = sample.tree;
    const duplicated = {
      ...sample.document,
      entries: [sample.document.entries[0], sample.document.entries[0]],
    };

    expectProblem(
      () => validateBaseline(JSON.parse(JSON.stringify(duplicated))),
      /duplicate path/,
    );
  });

  it('survives a baseline rewritten by an interrupted write', async () => {
    const sample = await sampleBaseline();
    tree = sample.tree;
    const target = tree.path('baseline.json');
    await writeBaseline(target, sample.document);
    const full = await readFile(target, 'utf8');
    await writeFile(target, full.slice(0, Math.floor(full.length / 2)));

    await expect(readBaseline(target)).rejects.toBeInstanceOf(BaselineError);
  });
});
