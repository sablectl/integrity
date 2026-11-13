#!/usr/bin/env node
/**
 * A small, honest benchmark.
 *
 * Builds a synthetic tree in a temporary directory, scans it, verifies it,
 * and prints what was measured together with the machine it was measured
 * on. The numbers are only meaningful next to that context, which is why
 * the script prints it rather than leaving a bare figure to be quoted out
 * of context.
 *
 * Usage:
 *   node scripts/benchmark.mjs [--files 5000] [--size 4096] [--concurrency 8]
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { cpus, totalmem, tmpdir, type as osType, release } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { scanDirectory } from '../dist/core/scan.js';
import { buildBaseline } from '../dist/core/baseline.js';
import { compareWithBaseline } from '../dist/core/verify.js';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

const fileCount = option('files', 5000);
const fileSize = option('size', 4096);
const concurrency = option('concurrency', 8);

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

const root = await mkdtemp(join(tmpdir(), 'integrity-bench-'));
try {
  process.stderr.write(
    `Creating ${fileCount} files of ${formatBytes(fileSize)} in ${root}\n`,
  );
  const payload = randomBytes(fileSize);
  for (let index = 0; index < fileCount; index += 1) {
    const directory = join(root, `dir-${String(Math.floor(index / 100))}`);
    if (index % 100 === 0) await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `file-${String(index)}.bin`), payload);
  }

  const scanStart = performance.now();
  const scan = await scanDirectory({ root, concurrency });
  const scanMs = performance.now() - scanStart;

  const baseline = buildBaseline(scan, 'benchmark');

  const verifyStart = performance.now();
  const second = await scanDirectory({ root, concurrency });
  const report = compareWithBaseline(baseline, second, {});
  const verifyMs = performance.now() - verifyStart;

  const totalBytes = scan.stats.totalBytes;
  const peak = process.memoryUsage().heapUsed;

  const lines = [
    '',
    'Integrity benchmark',
    `  Platform      ${osType()} ${release()} (${process.arch})`,
    `  Node          ${process.version}`,
    `  CPU           ${cpus()[0]?.model ?? 'unknown'} x${String(cpus().length)}`,
    `  Memory        ${formatBytes(totalmem())}`,
    '',
    `  Files         ${String(scan.stats.files)}`,
    `  Total size    ${formatBytes(totalBytes)}`,
    `  Concurrency   ${String(concurrency)}`,
    '',
    `  Scan          ${scanMs.toFixed(0)} ms  (${formatBytes((totalBytes / scanMs) * 1000)}/s, ${((fileCount / scanMs) * 1000).toFixed(0)} files/s)`,
    `  Verify        ${verifyMs.toFixed(0)} ms  (${formatBytes((totalBytes / verifyMs) * 1000)}/s)`,
    `  Heap in use   ${formatBytes(peak)}`,
    `  Result        ${report.status}`,
    '',
    '  Measured on this machine only. Figures vary with storage, filesystem',
    '  and cache state; re-run locally rather than quoting these.',
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
