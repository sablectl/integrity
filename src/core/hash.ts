/**
 * Streaming SHA-256 hashing.
 *
 * Files are read through a stream and fed to the digest in chunks, so memory
 * use stays flat regardless of file size. The file is opened once and both
 * the metadata and the contents are taken from that single descriptor: if the
 * path is replaced between the two operations, the recorded size and mtime
 * still describe the bytes that were actually hashed.
 */
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

/** Read size used when streaming file contents into the digest. */
export const HASH_CHUNK_BYTES = 64 * 1024;

export interface FileDigest {
  readonly sha256: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

export class FileTooLargeError extends Error {
  readonly size: number;
  readonly limit: number;

  constructor(size: number, limit: number) {
    super(
      `File is ${String(size)} bytes, above the limit of ${String(limit)} bytes.`,
    );
    this.name = 'FileTooLargeError';
    this.size = size;
    this.limit = limit;
  }
}

export class NotARegularFileError extends Error {
  constructor(message = 'Path is not a regular file.') {
    super(message);
    this.name = 'NotARegularFileError';
  }
}

export class HashCancelledError extends Error {
  constructor() {
    super('Hashing was cancelled.');
    this.name = 'HashCancelledError';
  }
}

export interface HashFileOptions {
  /** Refuse to hash files above this size. `null` disables the limit. */
  readonly maxBytes?: number | null;
  /**
   * Stops the read between chunks. Cancellation is checked here rather than
   * handed to the stream so the abort surfaces as one rejection from this
   * function, not as a stray `error` event on a stream nobody is listening
   * to any more.
   */
  readonly signal?: AbortSignal;
}

/**
 * Hashes a regular file and returns its digest together with the metadata
 * read from the same descriptor.
 *
 * Opened with `O_NOFOLLOW`-equivalent behaviour by the caller: traversal
 * decides whether a symlink is followed, and only hands real file paths here.
 */
export async function hashFile(
  filePath: string,
  options: HashFileOptions = {},
): Promise<FileDigest> {
  const maxBytes = options.maxBytes ?? null;
  const signal = options.signal;
  // Read through a function: a direct `signal.aborted` test narrows the
  // type for the rest of the scope, which would quietly turn the check
  // inside the read loop into dead code and leave long hashes
  // uninterruptible.
  const cancelled = (): boolean => signal?.aborted === true;
  if (cancelled()) throw new HashCancelledError();
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, 'r');
    const stats = await handle.stat({ bigint: false });
    if (!stats.isFile()) {
      throw new NotARegularFileError();
    }
    if (maxBytes !== null && stats.size > maxBytes) {
      throw new FileTooLargeError(stats.size, maxBytes);
    }

    const hash = createHash('sha256');
    let hashedBytes = 0;
    const stream = handle.createReadStream({
      highWaterMark: HASH_CHUNK_BYTES,
      autoClose: false,
    });
    for await (const chunk of stream) {
      if (cancelled()) {
        stream.destroy();
        throw new HashCancelledError();
      }
      const buffer = chunk as Buffer;
      hashedBytes += buffer.byteLength;
      if (maxBytes !== null && hashedBytes > maxBytes) {
        stream.destroy();
        throw new FileTooLargeError(hashedBytes, maxBytes);
      }
      hash.update(buffer);
    }

    return {
      sha256: hash.digest('hex'),
      size: hashedBytes,
      mtimeMs: Math.trunc(stats.mtimeMs),
      mode: stats.mode & 0o7777,
      uid: stats.uid,
      gid: stats.gid,
    };
  } finally {
    await handle?.close();
  }
}

/** Hashes a UTF-8 string, used for symlink targets. */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Hashes a buffer. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
