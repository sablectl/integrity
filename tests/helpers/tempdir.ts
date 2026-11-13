/**
 * Temporary directory fixtures.
 *
 * Every test that touches the filesystem gets its own directory under the
 * system temporary location and removes it afterwards. Nothing in the test
 * suite writes inside the repository.
 */
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  symlink,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempTree {
  readonly root: string;
  /** Creates (or replaces) a file, making parent directories as needed. */
  file(relativePath: string, contents: string | Uint8Array): Promise<string>;
  dir(relativePath: string): Promise<string>;
  link(relativePath: string, target: string): Promise<string>;
  chmod(relativePath: string, mode: number): Promise<void>;
  path(relativePath: string): string;
  cleanup(): Promise<void>;
}

/** Creates an isolated temporary directory. */
export async function makeTempTree(
  prefix = 'integrity-test-',
): Promise<TempTree> {
  const root = await mkdtemp(join(tmpdir(), prefix));

  const resolvePath = (relativePath: string): string =>
    join(root, relativePath);

  return {
    root,
    path: resolvePath,
    async file(relativePath, contents) {
      const target = resolvePath(relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents);
      return target;
    },
    async dir(relativePath) {
      const target = resolvePath(relativePath);
      await mkdir(target, { recursive: true });
      return target;
    },
    async link(relativePath, target) {
      const linkPath = resolvePath(relativePath);
      await mkdir(dirname(linkPath), { recursive: true });
      await symlink(target, linkPath);
      return linkPath;
    },
    async chmod(relativePath, mode) {
      await chmod(resolvePath(relativePath), mode);
    },
    async cleanup() {
      // Restore permissions first: a test that made a directory unreadable
      // would otherwise leave rubbish behind in the temporary location.
      await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(
        async () => {
          await chmod(root, 0o700).catch(() => undefined);
          await rm(root, { recursive: true, force: true });
        },
      );
    },
  };
}

/** True when the process can create a situation only an unprivileged user sees. */
export function canTestPermissionDenied(): boolean {
  // Running as root defeats permission tests: root reads everything.
  return process.platform !== 'win32' && process.getuid?.() !== 0;
}
