import { randomBytes } from 'node:crypto';
import { describe, expect, it, afterEach } from 'vitest';
import { scanDirectory } from '../../src/core/scan.js';
import { hashText } from '../../src/core/hash.js';
import { CancelledError, IoError } from '../../src/core/errors.js';
import { canTestPermissionDenied, makeTempTree } from '../helpers/tempdir.js';
import type { TempTree } from '../helpers/tempdir.js';

let tree: TempTree | undefined;
afterEach(async () => {
  await tree?.cleanup();
  tree = undefined;
});

describe('traversal', () => {
  it('records every regular file with a relative POSIX path', async () => {
    tree = await makeTempTree();
    await tree.file('a.txt', 'a');
    await tree.file('nested/deep/b.txt', 'b');

    const scan = await scanDirectory({ root: tree.root });

    expect(scan.entries.map((entry) => entry.path)).toEqual([
      'a.txt',
      'nested/deep/b.txt',
    ]);
    expect(scan.stats.files).toBe(2);
    expect(scan.skipped).toEqual([]);
  });

  it('orders entries deterministically regardless of creation order', async () => {
    tree = await makeTempTree();
    for (const name of ['z.txt', 'a.txt', 'm/n.txt', 'B.txt']) {
      await tree.file(name, name);
    }

    const first = await scanDirectory({ root: tree.root });
    const second = await scanDirectory({ root: tree.root });

    expect(first.entries.map((entry) => entry.path)).toEqual(
      [...first.entries.map((entry) => entry.path)].sort(),
    );
    expect(second.entries.map((entry) => entry.path)).toEqual(
      first.entries.map((entry) => entry.path),
    );
  });

  it('handles unicode and unusual filenames', async () => {
    tree = await makeTempTree();
    const names = [
      '日本語.txt',
      'ümlaut.txt',
      'with space.txt',
      "quote'name.txt",
    ];
    for (const name of names) await tree.file(name, name);

    const scan = await scanDirectory({ root: tree.root });

    expect(new Set(scan.entries.map((entry) => entry.path))).toEqual(
      new Set(names),
    );
  });

  it('applies exclusions and prunes excluded directories', async () => {
    tree = await makeTempTree();
    await tree.file('keep.txt', 'keep');
    await tree.file('logs/app.log', 'log');
    await tree.file('node_modules/pkg/index.js', 'code');

    const scan = await scanDirectory({
      root: tree.root,
      exclude: ['*.log', 'node_modules/'],
    });

    expect(scan.entries.map((entry) => entry.path)).toEqual(['keep.txt']);
  });

  it('refuses a root that is not a directory', async () => {
    tree = await makeTempTree();
    const file = await tree.file('plain.txt', 'x');

    await expect(scanDirectory({ root: file })).rejects.toBeInstanceOf(IoError);
  });

  it('reports a missing root as an IO error', async () => {
    tree = await makeTempTree();

    await expect(
      scanDirectory({ root: tree.path('does-not-exist') }),
    ).rejects.toBeInstanceOf(IoError);
  });
});

describe('symbolic links', () => {
  it('records a link by hashing its target string and does not follow it', async () => {
    tree = await makeTempTree();
    await tree.file('real.txt', 'real contents');
    await tree.link('alias.txt', 'real.txt');

    const scan = await scanDirectory({ root: tree.root });
    const link = scan.entries.find((entry) => entry.path === 'alias.txt');

    expect(link?.type).toBe('symlink');
    expect(link?.sha256).toBe(hashText('real.txt'));
    expect(link?.target).toBe('real.txt');
  });

  it('detects a link repointed at another file as a content change', async () => {
    tree = await makeTempTree();
    await tree.file('one.txt', '1');
    await tree.file('two.txt', '2');
    await tree.link('alias.txt', 'one.txt');
    const before = await scanDirectory({ root: tree.root });

    await tree.cleanup();
    tree = await makeTempTree();
    await tree.file('one.txt', '1');
    await tree.file('two.txt', '2');
    await tree.link('alias.txt', 'two.txt');
    const after = await scanDirectory({ root: tree.root });

    const hashOf = (scan: typeof before, path: string): string | undefined =>
      scan.entries.find((entry) => entry.path === path)?.sha256;
    expect(hashOf(before, 'alias.txt')).not.toBe(hashOf(after, 'alias.txt'));
  });

  it('does not loop forever on a symlink cycle', async () => {
    tree = await makeTempTree();
    await tree.dir('a/b');
    await tree.file('a/b/file.txt', 'x');
    // a/b/loop -> a, which would recurse endlessly if links were followed
    // without cycle detection.
    await tree.link('a/b/loop', tree.path('a'));

    const scan = await scanDirectory({ root: tree.root, followSymlinks: true });

    expect(scan.entries.some((entry) => entry.path === 'a/b/file.txt')).toBe(
      true,
    );
    expect(scan.skipped.some((skip) => skip.reason === 'cycle')).toBe(true);
  });

  it('follows links to files when asked', async () => {
    tree = await makeTempTree();
    await tree.file('real.txt', 'real contents');
    await tree.link('alias.txt', tree.path('real.txt'));

    const scan = await scanDirectory({ root: tree.root, followSymlinks: true });
    const alias = scan.entries.find((entry) => entry.path === 'alias.txt');
    const real = scan.entries.find((entry) => entry.path === 'real.txt');

    expect(alias?.type).toBe('file');
    expect(alias?.sha256).toBe(real?.sha256);
  });

  it('records a broken link rather than failing the scan', async () => {
    tree = await makeTempTree();
    await tree.link('dangling.txt', 'nowhere.txt');

    const scan = await scanDirectory({ root: tree.root });

    expect(
      scan.entries.find((entry) => entry.path === 'dangling.txt')?.type,
    ).toBe('symlink');
  });
});

describe('limits and refusals', () => {
  it('skips files above the size limit and says why', async () => {
    tree = await makeTempTree();
    await tree.file('small.bin', randomBytes(100));
    await tree.file('big.bin', randomBytes(5000));

    const scan = await scanDirectory({
      root: tree.root,
      maxFileSizeBytes: 1000,
    });

    expect(scan.entries.map((entry) => entry.path)).toEqual(['small.bin']);
    expect(scan.skipped).toEqual([
      expect.objectContaining({ path: 'big.bin', reason: 'too-large' }),
    ]);
  });

  it('stops descending past the depth limit and records the skip', async () => {
    tree = await makeTempTree();
    await tree.file('a/b/c/d/deep.txt', 'deep');

    const scan = await scanDirectory({ root: tree.root, maxDepth: 2 });

    expect(scan.entries).toEqual([]);
    expect(scan.skipped.some((skip) => skip.reason === 'max-depth')).toBe(true);
  });

  it('records an unreadable directory instead of aborting', async () => {
    if (!canTestPermissionDenied()) return;
    tree = await makeTempTree();
    await tree.file('readable.txt', 'fine');
    await tree.dir('locked');
    await tree.file('locked/secret.txt', 'secret');
    await tree.chmod('locked', 0o000);

    const scan = await scanDirectory({ root: tree.root });

    expect(scan.entries.map((entry) => entry.path)).toEqual(['readable.txt']);
    expect(scan.skipped).toEqual([
      expect.objectContaining({ path: 'locked', reason: 'unreadable' }),
    ]);
    await tree.chmod('locked', 0o700);
  });

  it('records an unreadable file instead of aborting', async () => {
    if (!canTestPermissionDenied()) return;
    tree = await makeTempTree();
    await tree.file('open.txt', 'fine');
    await tree.file('closed.txt', 'secret');
    await tree.chmod('closed.txt', 0o000);

    const scan = await scanDirectory({ root: tree.root });

    expect(scan.entries.map((entry) => entry.path)).toEqual(['open.txt']);
    expect(scan.skipped).toEqual([
      expect.objectContaining({ path: 'closed.txt', reason: 'unreadable' }),
    ]);
  });

  it('stops promptly when cancelled', async () => {
    tree = await makeTempTree();
    for (let index = 0; index < 50; index += 1) {
      await tree.file(`file-${String(index)}.bin`, randomBytes(2048));
    }
    const controller = new AbortController();
    controller.abort();

    await expect(
      scanDirectory({ root: tree.root, signal: controller.signal }),
    ).rejects.toBeInstanceOf(CancelledError);
  });

  it('reports progress while hashing', async () => {
    tree = await makeTempTree();
    for (let index = 0; index < 5; index += 1) {
      await tree.file(`f${String(index)}.txt`, 'contents');
    }
    const seen: number[] = [];

    await scanDirectory({
      root: tree.root,
      concurrency: 1,
      onProgress: (progress) => seen.push(progress.filesHashed),
    });

    expect(seen.at(-1)).toBe(5);
  });
});
