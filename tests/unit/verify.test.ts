import { describe, expect, it, afterEach } from 'vitest';
import { buildBaseline } from '../../src/core/baseline.js';
import { scanDirectory } from '../../src/core/scan.js';
import { compareWithBaseline, severityFor } from '../../src/core/verify.js';
import type {
  CompareOptions,
  VerificationReport,
} from '../../src/core/verify.js';
import type { Baseline } from '../../src/core/types.js';
import { canTestPermissionDenied, makeTempTree } from '../helpers/tempdir.js';
import type { TempTree } from '../helpers/tempdir.js';

let tree: TempTree | undefined;
afterEach(async () => {
  await tree?.cleanup();
  tree = undefined;
});

/** Builds a baseline of the current tree, then returns a fresh comparison. */
async function baselineOf(fixture: TempTree): Promise<Baseline> {
  const scan = await scanDirectory({ root: fixture.root });
  return buildBaseline(scan, '1.0.0');
}

async function compareNow(
  fixture: TempTree,
  baseline: Baseline,
  options: CompareOptions = {},
): Promise<VerificationReport> {
  const scan = await scanDirectory({ root: fixture.root });
  return compareWithBaseline(baseline, scan, options);
}

describe('change detection', () => {
  it('reports a clean tree as clean', async () => {
    tree = await makeTempTree();
    await tree.file('a.txt', 'alpha');
    const baseline = await baselineOf(tree);

    const report = await compareNow(tree, baseline);

    expect(report.status).toBe('clean');
    expect(report.complete).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.summary.unchanged).toBe(1);
  });

  it('detects a modified file', async () => {
    tree = await makeTempTree();
    await tree.file('a.txt', 'alpha');
    const baseline = await baselineOf(tree);
    await tree.file('a.txt', 'altered');

    const report = await compareNow(tree, baseline);

    expect(report.status).toBe('changes-detected');
    expect(report.summary.modified).toBe(1);
    expect(report.findings[0]).toMatchObject({
      path: 'a.txt',
      change: 'modified',
      severity: 'high',
    });
  });

  it('detects a file modified without changing its size', async () => {
    tree = await makeTempTree();
    await tree.file('a.txt', 'aaaaa');
    const baseline = await baselineOf(tree);
    await tree.file('a.txt', 'bbbbb');

    const report = await compareNow(tree, baseline);

    expect(report.summary.modified).toBe(1);
  });

  it('detects an added file', async () => {
    tree = await makeTempTree();
    await tree.file('a.txt', 'alpha');
    const baseline = await baselineOf(tree);
    await tree.file('new.txt', 'new');

    const report = await compareNow(tree, baseline);

    expect(report.summary.added).toBe(1);
    expect(report.findings[0]).toMatchObject({
      path: 'new.txt',
      change: 'added',
    });
  });

  it('detects a deleted file', async () => {
    tree = await makeTempTree();
    await tree.file('a.txt', 'alpha');
    await tree.file('b.txt', 'beta');
    const baseline = await baselineOf(tree);
    const { rm } = await import('node:fs/promises');
    await rm(tree.path('b.txt'));

    const report = await compareNow(tree, baseline);

    expect(report.summary.removed).toBe(1);
    expect(report.findings[0]).toMatchObject({
      path: 'b.txt',
      change: 'removed',
    });
  });

  it('treats a file replaced by a symlink as the most serious kind of change', async () => {
    tree = await makeTempTree();
    await tree.file('target.txt', 'target');
    await tree.file('a.txt', 'alpha');
    const baseline = await baselineOf(tree);
    const { rm } = await import('node:fs/promises');
    await rm(tree.path('a.txt'));
    await tree.link('a.txt', 'target.txt');

    const report = await compareNow(tree, baseline);

    expect(report.summary.typeChanged).toBe(1);
    expect(report.findings[0]).toMatchObject({
      change: 'type-changed',
      severity: 'critical',
    });
  });

  it('reports permission changes only when metadata checking is on', async () => {
    if (!canTestPermissionDenied()) return;
    tree = await makeTempTree();
    await tree.file('a.txt', 'alpha');
    await tree.chmod('a.txt', 0o644);
    const baseline = await baselineOf(tree);
    await tree.chmod('a.txt', 0o600);

    const without = await compareNow(tree, baseline, { checkMetadata: false });
    const with_ = await compareNow(tree, baseline, { checkMetadata: true });

    expect(without.status).toBe('clean');
    expect(with_.summary.metadataChanged).toBe(1);
    expect(with_.findings[0]?.severity).toBe('low');
  });

  it('sorts findings by path so two runs produce identical output', async () => {
    tree = await makeTempTree();
    await tree.file('a.txt', 'a');
    const baseline = await baselineOf(tree);
    for (const name of ['z.txt', 'b.txt', 'm.txt']) await tree.file(name, name);

    const report = await compareNow(tree, baseline);

    expect(report.findings.map((finding) => finding.path)).toEqual([
      'b.txt',
      'm.txt',
      'z.txt',
    ]);
  });
});

describe('incomplete verification', () => {
  it('never reports clean when a file could not be read', async () => {
    if (!canTestPermissionDenied()) return;
    tree = await makeTempTree();
    await tree.file('a.txt', 'alpha');
    await tree.file('locked.txt', 'secret');
    const baseline = await baselineOf(tree);
    await tree.chmod('locked.txt', 0o000);

    const report = await compareNow(tree, baseline);

    expect(report.status).toBe('incomplete');
    expect(report.complete).toBe(false);
    expect(report.summary.unreadable).toBe(1);
    expect(report.summary.removed).toBe(0);
  });

  it('distinguishes an unreadable file from a deleted one', async () => {
    if (!canTestPermissionDenied()) return;
    tree = await makeTempTree();
    await tree.file('gone.txt', 'x');
    await tree.file('locked.txt', 'y');
    const baseline = await baselineOf(tree);
    const { rm } = await import('node:fs/promises');
    await rm(tree.path('gone.txt'));
    await tree.chmod('locked.txt', 0o000);

    const report = await compareNow(tree, baseline);

    const byPath = new Map(report.findings.map((f) => [f.path, f.change]));
    expect(byPath.get('gone.txt')).toBe('removed');
    expect(byPath.get('locked.txt')).toBe('unreadable');
  });

  it('still reports changes when some entries were unreadable', async () => {
    if (!canTestPermissionDenied()) return;
    tree = await makeTempTree();
    await tree.file('a.txt', 'alpha');
    await tree.file('locked.txt', 'secret');
    const baseline = await baselineOf(tree);
    await tree.file('a.txt', 'changed');
    await tree.chmod('locked.txt', 0o000);

    const report = await compareNow(tree, baseline);

    expect(report.status).toBe('changes-detected');
    expect(report.complete).toBe(false);
  });

  it('reports a tampered baseline as untrusted, outranking any change', async () => {
    tree = await makeTempTree();
    await tree.file('a.txt', 'alpha');
    const baseline = await baselineOf(tree);
    await tree.file('a.txt', 'changed');

    const report = await compareNow(tree, baseline, {
      signature: { status: 'invalid', reason: 'test' },
    });

    expect(report.status).toBe('baseline-untrusted');
    expect(report.signature.reason).toBe('test');
  });
});

describe('severity assignment', () => {
  it('assigns a stable severity to each change type', () => {
    expect(severityFor('type-changed')).toBe('critical');
    expect(severityFor('modified')).toBe('high');
    expect(severityFor('removed')).toBe('high');
    expect(severityFor('added')).toBe('medium');
    expect(severityFor('unreadable')).toBe('medium');
    expect(severityFor('metadata')).toBe('low');
  });
});
