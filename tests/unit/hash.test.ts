import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, afterEach } from 'vitest';
import {
  FileTooLargeError,
  NotARegularFileError,
  hashBytes,
  hashFile,
  hashText,
} from '../../src/core/hash.js';
import { makeTempTree } from '../helpers/tempdir.js';
import type { TempTree } from '../helpers/tempdir.js';

let tree: TempTree | undefined;
afterEach(async () => {
  await tree?.cleanup();
  tree = undefined;
});

describe('SHA-256 correctness', () => {
  it('matches the published digest of the empty string', () => {
    expect(hashText('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches the published digest of "abc"', () => {
    expect(hashText('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes a file to the same digest as node:crypto over its bytes', async () => {
    tree = await makeTempTree();
    const payload = randomBytes(300_000);
    const path = await tree.file('blob.bin', payload);
    const expected = createHash('sha256').update(payload).digest('hex');

    const digest = await hashFile(path);

    expect(digest.sha256).toBe(expected);
    expect(digest.size).toBe(payload.byteLength);
  });

  it('streams a file larger than the read buffer without truncating it', async () => {
    tree = await makeTempTree();
    // Several times the 64 KiB chunk size, so the streaming path is used.
    const payload = randomBytes(5 * 64 * 1024 + 17);
    const path = await tree.file('large.bin', payload);

    const digest = await hashFile(path);

    expect(digest.sha256).toBe(hashBytes(payload));
    expect(digest.size).toBe(payload.byteLength);
  });

  it('reports the metadata of the file it actually read', async () => {
    tree = await makeTempTree();
    const path = await tree.file('meta.txt', 'contents');
    await tree.chmod('meta.txt', 0o640);

    const digest = await hashFile(path);

    expect(digest.mode).toBe(0o640);
    expect(digest.mtimeMs).toBeGreaterThan(0);
  });
});

describe('hashFile limits and refusals', () => {
  it('refuses a file above the size limit', async () => {
    tree = await makeTempTree();
    const path = await tree.file('big.bin', randomBytes(2048));

    await expect(hashFile(path, { maxBytes: 1024 })).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
  });

  it('accepts a file exactly at the limit', async () => {
    tree = await makeTempTree();
    const path = await tree.file('exact.bin', randomBytes(1024));

    await expect(hashFile(path, { maxBytes: 1024 })).resolves.toMatchObject({
      size: 1024,
    });
  });

  it('refuses a directory', async () => {
    tree = await makeTempTree();
    const path = await tree.dir('subdir');

    await expect(hashFile(path)).rejects.toBeInstanceOf(NotARegularFileError);
  });

  it('rejects rather than returning a partial digest when aborted', async () => {
    tree = await makeTempTree();
    const path = await tree.file('abort.bin', randomBytes(4 * 1024 * 1024));
    const controller = new AbortController();
    controller.abort();

    await expect(
      hashFile(path, { signal: controller.signal }),
    ).rejects.toThrow();
  });
});
