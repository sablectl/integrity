/**
 * Integration tests.
 *
 * These spawn the compiled binary the way an operator or a CI job would, so
 * they exercise the parts the in-process tests cannot: the shebang, the real
 * exit code of the process, signal handling, piped output, and behaviour on
 * genuinely large inputs.
 *
 * They require `npm run build` to have been run first.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeTempTree } from '../helpers/tempdir.js';
import type { TempTree } from '../helpers/tempdir.js';

const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const binary = join(projectRoot, 'dist', 'bin', 'integrity.js');

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runBinary(
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string } = {
    cwd: projectRoot,
  },
): Promise<Run> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: '1', ...options.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on(
      'data',
      (chunk: Buffer) => (stdout += chunk.toString('utf8')),
    );
    child.stderr.on(
      'data',
      (chunk: Buffer) => (stderr += chunk.toString('utf8')),
    );
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

let tree: TempTree | undefined;
afterEach(async () => {
  await tree?.cleanup();
  tree = undefined;
});

beforeAll(async () => {
  await access(binary).catch(() => {
    throw new Error(
      `The compiled binary is missing at ${binary}. Run "npm run build" first.`,
    );
  });
});

describe('the compiled binary', () => {
  it('reports the installed version from the package manifest', async () => {
    const manifest = JSON.parse(
      await readFile(join(projectRoot, 'package.json'), 'utf8'),
    ) as { version: string };

    const result = await runBinary(['--version'], { cwd: projectRoot });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(`Integrity v${manifest.version}`);
  });

  it('prints help and exits 0', async () => {
    const result = await runBinary(['--help'], { cwd: projectRoot });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('File Integrity Monitoring Toolkit');
  });

  it('writes no colour escape sequences when output is piped', async () => {
    const result = await runBinary(['--help'], {
      cwd: projectRoot,
      env: { NO_COLOR: '' },
    });

    expect(result.stdout).not.toContain('\u001B[');
  });
});

describe('end-to-end workflow', () => {
  it('scans, verifies clean, then detects every kind of change', async () => {
    tree = await makeTempTree();
    await tree.file('app/main.js', 'console.log(1);\n');
    await tree.file('app/config.json', '{"a":1}\n');
    await tree.file('docs/readme.md', '# docs\n');
    await tree.file('target.txt', 'target\n');

    const scan = await runBinary(['scan', '.'], { cwd: tree.root });
    expect(scan.code).toBe(0);

    const clean = await runBinary(['verify', '.'], { cwd: tree.root });
    expect(clean.code).toBe(0);

    await tree.file('app/main.js', 'console.log(2);\n');
    const { rm } = await import('node:fs/promises');
    await rm(tree.path('docs/readme.md'));
    await tree.file('new.txt', 'new\n');
    await rm(tree.path('app/config.json'));
    await tree.link('app/config.json', '../target.txt');

    const dirty = await runBinary(['verify', '.', '--json'], {
      cwd: tree.root,
    });
    expect(dirty.code).toBe(1);
    const report = JSON.parse(dirty.stdout) as {
      summary: {
        modified: number;
        added: number;
        removed: number;
        typeChanged: number;
      };
      findings: { change: string }[];
    };
    expect(report.summary.modified).toBe(1);
    expect(report.summary.added).toBe(1);
    expect(report.summary.removed).toBe(1);
    expect(report.summary.typeChanged).toBe(1);
  });

  it('can keep the baseline outside the directory it protects', async () => {
    tree = await makeTempTree();
    await tree.dir('data');
    await tree.file('data/a.txt', 'alpha');
    const baseline = tree.path('vault/baseline.json');

    const scan = await runBinary(['scan', 'data', '--baseline', baseline], {
      cwd: tree.root,
    });
    const verify = await runBinary(['verify', 'data', '--baseline', baseline], {
      cwd: tree.root,
    });

    expect(scan.code).toBe(0);
    expect(verify.code).toBe(0);
  });

  it('round-trips a report through a pipe', async () => {
    tree = await makeTempTree();
    await tree.file('a.txt', 'alpha');
    await runBinary(['scan', '.'], { cwd: tree.root });
    await tree.file('a.txt', 'changed');
    const verify = await runBinary(['verify', '.', '--json'], {
      cwd: tree.root,
    });

    const rendered = await runBinary(['report', '--input', '-'], {
      cwd: tree.root,
      input: verify.stdout,
    });

    expect(rendered.code).toBe(1);
    expect(rendered.stdout).toContain('modified');
  });

  it('uses a configuration file written by init', async () => {
    tree = await makeTempTree();
    await tree.file('keep.txt', 'keep');
    await tree.file('noise.log', 'noise');

    await runBinary(['init'], { cwd: tree.root });
    await runBinary(['scan', '.'], { cwd: tree.root });
    const verify = await runBinary(['verify', '.', '--json'], {
      cwd: tree.root,
    });

    const report = JSON.parse(verify.stdout) as {
      summary: { checked: number };
    };
    // integrity.config.json itself is recorded; the log file is excluded.
    expect(verify.code).toBe(0);
    expect(report.summary.checked).toBe(2);
  });
});

describe('large and awkward inputs', () => {
  it('hashes a file larger than memory comfort without loading it whole', async () => {
    tree = await makeTempTree();
    // 64 MiB: large enough that a non-streaming implementation would show.
    const chunk = randomBytes(1024 * 1024);
    const { open } = await import('node:fs/promises');
    const handle = await open(tree.path('large.bin'), 'w');
    for (let index = 0; index < 64; index += 1) await handle.write(chunk);
    await handle.close();

    const scan = await runBinary(['scan', '.', '--max-file-size', 'off'], {
      cwd: tree.root,
    });
    const verify = await runBinary(['verify', '.'], { cwd: tree.root });

    expect(scan.code).toBe(0);
    expect(verify.code).toBe(0);
  });

  it('handles unicode and awkward filenames end to end', async () => {
    tree = await makeTempTree();
    await tree.file('日本語/メモ.txt', 'memo');
    await tree.file('with space/and-dash.txt', 'x');
    await tree.file('quote\'and"double.txt', 'y');

    const scan = await runBinary(['scan', '.'], { cwd: tree.root });
    const verify = await runBinary(['verify', '.'], { cwd: tree.root });

    expect(scan.code).toBe(0);
    expect(verify.code).toBe(0);
  });

  it('escapes control characters in a filename instead of printing them', async () => {
    tree = await makeTempTree();
    await tree.file('plain.txt', 'a');
    await runBinary(['scan', '.'], { cwd: tree.root });
    await tree.file('sneaky\u001B[2K\rOK.txt', 'b');

    const verify = await runBinary(['verify', '.'], { cwd: tree.root });

    expect(verify.code).toBe(1);
    expect(verify.stdout).not.toContain('\u001B[2K');
    expect(verify.stdout).toContain('\\x1b');
  });
});

describe('watch mode against the real filesystem', () => {
  it('notices a change made while it is running and stops cleanly on SIGINT', async () => {
    tree = await makeTempTree();
    await tree.file('watched.txt', 'original');
    await runBinary(['scan', '.'], { cwd: tree.root });

    const child = spawn(
      process.execPath,
      [binary, 'watch', '.', '--json', '--debounce', '50', '--interval', '1'],
      { cwd: tree.root, env: { ...process.env, NO_COLOR: '1' } },
    );
    let stdout = '';
    child.stdout.on(
      'data',
      (chunk: Buffer) => (stdout += chunk.toString('utf8')),
    );

    // Wait for the initial verification before changing anything.
    await waitFor(() => stdout.includes('"trigger":"initial"'), 15_000);
    await tree.file('watched.txt', 'tampered');

    await waitFor(() => stdout.includes('"status":"changes-detected"'), 15_000);
    child.kill('SIGINT');
    const code = await new Promise<number>((resolveExit) => {
      child.on('close', (value) => {
        resolveExit(value ?? -1);
      });
    });

    const lines = stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    expect(stdout).toContain('"event":"stopped"');
    expect([1, 130]).toContain(code);
  });
});

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error('Timed out waiting for the expected output.');
}
