import { readFile, rm } from 'node:fs/promises';
import { describe, expect, it, afterEach } from 'vitest';
import { runCli } from '../helpers/cli.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { canTestPermissionDenied, makeTempTree } from '../helpers/tempdir.js';
import type { TempTree } from '../helpers/tempdir.js';

let tree: TempTree | undefined;
afterEach(async () => {
  await tree?.cleanup();
  tree = undefined;
});

const KEY = 'a-test-key-of-sufficient-length-0123456789';

describe('top-level behaviour', () => {
  it('prints the installed version', async () => {
    tree = await makeTempTree();

    const result = await runCli(['--version'], { cwd: tree.root });

    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout.trim()).toMatch(/^Integrity v\d+\.\d+\.\d+/);
  });

  it('prints help listing every command', async () => {
    tree = await makeTempTree();

    const result = await runCli(['--help'], { cwd: tree.root });

    expect(result.code).toBe(ExitCode.Ok);
    for (const name of ['init', 'scan', 'verify', 'watch', 'report']) {
      expect(result.stdout).toContain(name);
    }
  });

  it('gives every command its own help', async () => {
    tree = await makeTempTree();

    for (const name of ['init', 'scan', 'verify', 'watch', 'report']) {
      const result = await runCli([name, '--help'], { cwd: tree.root });
      expect(result.code).toBe(ExitCode.Ok);
      expect(result.stdout).toContain('Usage:');
      expect(result.stdout).toContain('Examples:');
    }
  });

  it('treats no arguments as a usage error but still shows help', async () => {
    tree = await makeTempTree();

    const result = await runCli([], { cwd: tree.root });

    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stdout).toContain('Usage:');
  });

  it('rejects an unknown command', async () => {
    tree = await makeTempTree();

    const result = await runCli(['frobnicate'], { cwd: tree.root });

    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('Unknown command');
  });
});

describe('init', () => {
  it('writes a configuration file and refuses to clobber it', async () => {
    tree = await makeTempTree();

    const first = await runCli(['init'], { cwd: tree.root });
    const second = await runCli(['init'], { cwd: tree.root });
    const forced = await runCli(['init', '--force'], { cwd: tree.root });

    expect(first.code).toBe(ExitCode.Ok);
    expect(second.code).toBe(ExitCode.RuntimeError);
    expect(forced.code).toBe(ExitCode.Ok);
    const config: unknown = JSON.parse(
      await readFile(tree.path('integrity.config.json'), 'utf8'),
    );
    expect(config).toMatchObject({ followSymlinks: false });
  });

  it('can print the configuration instead of writing it', async () => {
    tree = await makeTempTree();

    const result = await runCli(['init', '--print'], { cwd: tree.root });

    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toMatchObject({ recordMetadata: true });
  });
});

describe('scan and verify', () => {
  async function fixture(): Promise<TempTree> {
    const fresh = await makeTempTree();
    await fresh.file('app/main.js', 'console.log(1);\n');
    await fresh.file('app/lib/helper.js', 'export const x = 1;\n');
    await fresh.file('readme.md', '# readme\n');
    return fresh;
  }

  it('creates a baseline and verifies it as clean', async () => {
    tree = await fixture();

    const scan = await runCli(['scan', '.'], { cwd: tree.root });
    const verify = await runCli(['verify', '.'], { cwd: tree.root });

    expect(scan.code).toBe(ExitCode.Ok);
    expect(verify.code).toBe(ExitCode.Ok);
    expect(verify.stdout).toContain('OK');
  });

  it('does not report its own baseline as an added file', async () => {
    tree = await fixture();
    await runCli(['scan', '.'], { cwd: tree.root });

    const verify = await runCli(['verify', '.', '--json'], { cwd: tree.root });

    const report = JSON.parse(verify.stdout) as { findings: unknown[] };
    expect(report.findings).toEqual([]);
  });

  it('refuses to replace a baseline without --force', async () => {
    tree = await fixture();
    await runCli(['scan', '.'], { cwd: tree.root });

    const again = await runCli(['scan', '.'], { cwd: tree.root });
    const forced = await runCli(['scan', '.', '--force'], { cwd: tree.root });

    expect(again.code).toBe(ExitCode.RuntimeError);
    expect(again.stderr).toContain('Refusing to overwrite');
    expect(forced.code).toBe(ExitCode.Ok);
  });

  it('exits 1 when files changed', async () => {
    tree = await fixture();
    await runCli(['scan', '.'], { cwd: tree.root });
    await tree.file('app/main.js', 'console.log(2);\n');

    const verify = await runCli(['verify', '.'], { cwd: tree.root });

    expect(verify.code).toBe(ExitCode.ChangesDetected);
    expect(verify.stdout).toContain('CHANGES DETECTED');
  });

  it('exits 2 when something could not be checked', async () => {
    if (!canTestPermissionDenied()) return;
    tree = await fixture();
    await runCli(['scan', '.'], { cwd: tree.root });
    await tree.chmod('readme.md', 0o000);

    const verify = await runCli(['verify', '.'], { cwd: tree.root });

    expect(verify.code).toBe(ExitCode.Incomplete);
    expect(verify.stdout).toContain('INCOMPLETE');
  });

  it('exits 3 when the baseline is missing', async () => {
    tree = await fixture();

    const verify = await runCli(['verify', '.'], { cwd: tree.root });

    expect(verify.code).toBe(ExitCode.BaselineUntrusted);
    expect(verify.stderr).toContain('No baseline');
  });

  it('exits 3 when the baseline is corrupt', async () => {
    tree = await fixture();
    await runCli(['scan', '.'], { cwd: tree.root });
    await tree.file('.integrity/baseline.json', '{"schemaVersion": 1, trunca');

    const verify = await runCli(['verify', '.'], { cwd: tree.root });

    expect(verify.code).toBe(ExitCode.BaselineUntrusted);
  });

  it('exits 3 when a signed baseline fails its integrity check', async () => {
    tree = await fixture();
    await runCli(['scan', '.'], {
      cwd: tree.root,
      env: { INTEGRITY_KEY: KEY },
    });
    const raw = JSON.parse(
      await readFile(tree.path('.integrity/baseline.json'), 'utf8'),
    ) as { entries: { sha256: string }[] };
    raw.entries[0]!.sha256 = '0'.repeat(64);
    await tree.file('.integrity/baseline.json', JSON.stringify(raw));

    const verify = await runCli(['verify', '.'], {
      cwd: tree.root,
      env: { INTEGRITY_KEY: KEY },
    });

    expect(verify.code).toBe(ExitCode.BaselineUntrusted);
    expect(verify.stdout).toContain('BASELINE UNTRUSTED');
  });

  it('says plainly when a signed baseline was not verified', async () => {
    tree = await fixture();
    await runCli(['scan', '.'], {
      cwd: tree.root,
      env: { INTEGRITY_KEY: KEY },
    });

    const verify = await runCli(['verify', '.'], { cwd: tree.root });

    expect(verify.stdout).toContain('not verified');
    expect(verify.code).toBe(ExitCode.Ok);
  });

  it('honours exclusions given on the command line', async () => {
    tree = await fixture();
    await runCli(['scan', '.', '--exclude', '*.md'], { cwd: tree.root });

    const verify = await runCli(['verify', '.', '--json'], { cwd: tree.root });
    const report = JSON.parse(verify.stdout) as {
      summary: { checked: number };
    };

    expect(report.summary.checked).toBe(2);
  });

  it('writes a JSON report to a file when asked', async () => {
    tree = await fixture();
    await runCli(['scan', '.'], { cwd: tree.root });

    const verify = await runCli(['verify', '.', '--output', 'report.json'], {
      cwd: tree.root,
    });
    const saved: unknown = JSON.parse(
      await readFile(tree.path('report.json'), 'utf8'),
    );

    expect(verify.code).toBe(ExitCode.Ok);
    expect(saved).toMatchObject({ status: 'clean' });
  });

  it('produces JSON on stdout that is valid and complete', async () => {
    tree = await fixture();
    await runCli(['scan', '.'], { cwd: tree.root });
    await tree.file('extra.txt', 'extra');
    await rm(tree.path('readme.md'));

    const verify = await runCli(['verify', '.', '--json'], { cwd: tree.root });
    const report = JSON.parse(verify.stdout) as {
      status: string;
      summary: { added: number; removed: number };
      findings: { path: string; change: string; severity: string }[];
    };

    expect(report.status).toBe('changes-detected');
    expect(report.summary.added).toBe(1);
    expect(report.summary.removed).toBe(1);
    expect(report.findings.map((finding) => finding.path)).toEqual([
      'extra.txt',
      'readme.md',
    ]);
  });

  it('rejects an unknown option instead of carrying on', async () => {
    tree = await fixture();

    const result = await runCli(['scan', '--exlude', '*.log'], {
      cwd: tree.root,
    });

    expect(result.code).toBe(ExitCode.UsageError);
  });

  it('rejects more than one directory', async () => {
    tree = await fixture();

    const result = await runCli(['scan', 'app', 'readme.md'], {
      cwd: tree.root,
    });

    expect(result.code).toBe(ExitCode.UsageError);
  });
});

describe('report', () => {
  it('re-renders a saved report with the same exit code', async () => {
    tree = await makeTempTree();
    await tree.file('a.txt', 'alpha');
    await runCli(['scan', '.'], { cwd: tree.root });
    await tree.file('a.txt', 'changed');
    await runCli(['verify', '.', '--output', 'report.json'], {
      cwd: tree.root,
    });

    const rendered = await runCli(['report', '--input', 'report.json'], {
      cwd: tree.root,
    });

    expect(rendered.code).toBe(ExitCode.ChangesDetected);
    expect(rendered.stdout).toContain('a.txt');
  });

  it('refuses a file that is not a report', async () => {
    tree = await makeTempTree();
    await tree.file('notes.json', '{"hello": "world"}');

    const result = await runCli(['report', '--input', 'notes.json'], {
      cwd: tree.root,
    });

    expect(result.code).toBe(ExitCode.UsageError);
  });

  it('runs a verification when given no input', async () => {
    tree = await makeTempTree();
    await tree.file('a.txt', 'alpha');
    await runCli(['scan', '.'], { cwd: tree.root });

    const result = await runCli(['report', '.'], { cwd: tree.root });

    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('Summary');
  });
});

describe('watch', () => {
  it('verifies once and exits with --once', async () => {
    tree = await makeTempTree();
    await tree.file('a.txt', 'alpha');
    await runCli(['scan', '.'], { cwd: tree.root });

    const result = await runCli(['watch', '.', '--once'], { cwd: tree.root });

    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('initial check');
  });

  it('reports drift found by the initial check', async () => {
    tree = await makeTempTree();
    await tree.file('a.txt', 'alpha');
    await runCli(['scan', '.'], { cwd: tree.root });
    await tree.file('a.txt', 'changed');

    const result = await runCli(['watch', '.', '--once'], { cwd: tree.root });

    expect(result.code).toBe(ExitCode.ChangesDetected);
  });

  it('emits one JSON object per line with --json', async () => {
    tree = await makeTempTree();
    await tree.file('a.txt', 'alpha');
    await runCli(['scan', '.'], { cwd: tree.root });

    const result = await runCli(['watch', '.', '--once', '--json'], {
      cwd: tree.root,
    });

    const lines = result.stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });
});
