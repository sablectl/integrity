/**
 * Comparison of a live directory against a baseline.
 *
 * The comparison is a set difference over sorted relative paths, which makes
 * the result deterministic and independent of the order the filesystem
 * happened to return entries in.
 *
 * One rule governs the whole module: a run is only reported as clean when
 * every entry was actually checked. Files that could not be read, files
 * above the size limit, directories that could not be listed and entries
 * skipped on either side are counted separately and make the result
 * incomplete. "Nothing changed" and "we could not tell whether anything
 * changed" are different answers, and conflating them is how an integrity
 * tool ends up reassuring someone about files it never looked at.
 */
import { comparePaths } from './paths.js';
import type { SignatureState } from './signature.js';
import type {
  Baseline,
  BaselineEntry,
  ScanResult,
  SkippedEntry,
} from './types.js';

export type ChangeType =
  'added' | 'removed' | 'modified' | 'type-changed' | 'metadata' | 'unreadable';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Overall outcome of a verification run. */
export type VerificationStatus =
  'clean' | 'changes-detected' | 'incomplete' | 'baseline-untrusted';

export interface FindingSnapshot {
  readonly type?: string;
  readonly size?: number;
  readonly sha256?: string;
  readonly mtimeMs?: number;
  readonly mode?: number;
  readonly uid?: number;
  readonly gid?: number;
}

export interface Finding {
  readonly path: string;
  readonly change: ChangeType;
  readonly severity: Severity;
  readonly details: readonly string[];
  readonly expected?: FindingSnapshot;
  readonly actual?: FindingSnapshot;
}

export interface VerificationSummary {
  readonly checked: number;
  readonly unchanged: number;
  readonly added: number;
  readonly removed: number;
  readonly modified: number;
  readonly typeChanged: number;
  readonly metadataChanged: number;
  readonly unreadable: number;
  readonly skipped: number;
}

export interface VerificationReport {
  readonly tool: { readonly name: string; readonly version: string };
  readonly generatedAt: string;
  readonly root: string;
  readonly baselinePath?: string;
  readonly baselineCreatedAt: string;
  readonly signature: {
    readonly status: SignatureState['status'];
    readonly reason?: string;
    readonly keyId?: string;
  };
  readonly status: VerificationStatus;
  /** True only when every baseline entry and every live entry was checked. */
  readonly complete: boolean;
  readonly summary: VerificationSummary;
  readonly findings: readonly Finding[];
  readonly skipped: readonly SkippedEntry[];
  readonly durationMs: number;
}

export interface CompareOptions {
  /** Compare permissions and ownership as well as contents. */
  readonly checkMetadata?: boolean;
  /** Report modification-time differences on otherwise identical files. */
  readonly checkMtime?: boolean;
  readonly baselinePath?: string;
  readonly signature?: SignatureState;
  readonly toolVersion?: string;
  readonly generatedAt?: Date;
  readonly durationMs?: number;
}

const SEVERITY_BY_CHANGE: Record<ChangeType, Severity> = {
  // A file whose contents differ from the trusted state is the event this
  // tool exists to find.
  modified: 'high',
  // A path that was protected and is now gone is equally significant: it is
  // the usual shape of log or binary removal.
  removed: 'high',
  // A regular file replaced by a symlink, or the reverse, is a classic
  // substitution and is never an accident.
  'type-changed': 'critical',
  // New files matter, but the baseline never promised anything about them.
  added: 'medium',
  // Permissions and ownership changes are worth knowing about and are
  // frequently benign.
  metadata: 'low',
  // Not a detected change: a gap in coverage.
  unreadable: 'medium',
};

/** Returns the severity assigned to a change type. */
export function severityFor(change: ChangeType): Severity {
  return SEVERITY_BY_CHANGE[change];
}

/** Compares a scan of the live tree against a baseline. */
export function compareWithBaseline(
  baseline: Baseline,
  scan: ScanResult,
  options: CompareOptions = {},
): VerificationReport {
  const findings: Finding[] = [];
  const baselineByPath = new Map<string, BaselineEntry>();
  for (const entry of baseline.entries) baselineByPath.set(entry.path, entry);
  const currentByPath = new Map<string, BaselineEntry>();
  for (const entry of scan.entries) currentByPath.set(entry.path, entry);

  const checkMetadata = options.checkMetadata ?? false;
  const checkMtime = options.checkMtime ?? false;

  let unchanged = 0;
  let added = 0;
  let removed = 0;
  let modified = 0;
  let typeChanged = 0;
  let metadataChanged = 0;

  // Paths skipped in this run cannot be judged either way.
  const unreadableNow = new Map<string, SkippedEntry>();
  for (const skip of scan.skipped) unreadableNow.set(skip.path, skip);

  for (const entry of baseline.entries) {
    const current = currentByPath.get(entry.path);
    if (!current) {
      const skip = unreadableNow.get(entry.path);
      if (skip) {
        findings.push({
          path: entry.path,
          change: 'unreadable',
          severity: severityFor('unreadable'),
          details: [`Could not be checked: ${skip.message}`],
          expected: snapshot(entry),
        });
        continue;
      }
      findings.push({
        path: entry.path,
        change: 'removed',
        severity: severityFor('removed'),
        details: ['Present in the baseline, missing from the filesystem.'],
        expected: snapshot(entry),
      });
      removed += 1;
      continue;
    }

    if (entry.type !== current.type) {
      findings.push({
        path: entry.path,
        change: 'type-changed',
        severity: severityFor('type-changed'),
        details: [`Was a ${entry.type}, is now a ${current.type}.`],
        expected: snapshot(entry),
        actual: snapshot(current),
      });
      typeChanged += 1;
      continue;
    }

    if (entry.sha256 !== current.sha256) {
      const details = [
        entry.type === 'symlink'
          ? `Link target changed from ${String(entry.target)} to ${String(current.target)}.`
          : 'Contents differ from the baseline.',
      ];
      if (entry.size !== current.size) {
        details.push(
          `Size ${String(entry.size)} → ${String(current.size)} bytes.`,
        );
      }
      findings.push({
        path: entry.path,
        change: 'modified',
        severity: severityFor('modified'),
        details,
        expected: snapshot(entry),
        actual: snapshot(current),
      });
      modified += 1;
      continue;
    }

    const metadataDetails = metadataDifferences(
      entry,
      current,
      checkMetadata,
      checkMtime,
    );
    if (metadataDetails.length > 0) {
      findings.push({
        path: entry.path,
        change: 'metadata',
        severity: severityFor('metadata'),
        details: metadataDetails,
        expected: snapshot(entry),
        actual: snapshot(current),
      });
      metadataChanged += 1;
      continue;
    }

    unchanged += 1;
  }

  for (const entry of scan.entries) {
    if (baselineByPath.has(entry.path)) continue;
    findings.push({
      path: entry.path,
      change: 'added',
      severity: severityFor('added'),
      details: ['Present on the filesystem, missing from the baseline.'],
      actual: snapshot(entry),
    });
    added += 1;
  }

  // Entries skipped in this run that the baseline never knew about are still
  // coverage gaps, and they are reported as such.
  for (const skip of scan.skipped) {
    if (baselineByPath.has(skip.path)) continue;
    findings.push({
      path: skip.path,
      change: 'unreadable',
      severity: severityFor('unreadable'),
      details: [`Could not be checked: ${skip.message}`],
    });
  }

  findings.sort(
    (left, right) =>
      comparePaths(left.path, right.path) ||
      compareChange(left.change, right.change),
  );

  const unreadable = findings.filter(
    (finding) => finding.change === 'unreadable',
  ).length;
  const summary: VerificationSummary = {
    checked: baseline.entries.length,
    unchanged,
    added,
    removed,
    modified,
    typeChanged,
    metadataChanged,
    unreadable,
    skipped: scan.skipped.length,
  };

  const hasChanges =
    added + removed + modified + typeChanged + metadataChanged > 0;
  const complete = unreadable === 0 && scan.skipped.length === 0;
  const signature = options.signature ?? { status: 'unsigned' as const };

  const status: VerificationStatus =
    signature.status === 'invalid'
      ? 'baseline-untrusted'
      : hasChanges
        ? 'changes-detected'
        : complete
          ? 'clean'
          : 'incomplete';

  return {
    tool: {
      name: 'integrity',
      version: options.toolVersion ?? baseline.tool.version,
    },
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    root: scan.root,
    ...(options.baselinePath ? { baselinePath: options.baselinePath } : {}),
    baselineCreatedAt: baseline.createdAt,
    signature: {
      status: signature.status,
      ...('reason' in signature ? { reason: signature.reason } : {}),
      ...(baseline.signature?.keyId ? { keyId: baseline.signature.keyId } : {}),
    },
    status,
    complete,
    summary,
    findings,
    skipped: scan.skipped,
    durationMs: options.durationMs ?? scan.durationMs,
  };
}

function metadataDifferences(
  expected: BaselineEntry,
  actual: BaselineEntry,
  checkMetadata: boolean,
  checkMtime: boolean,
): string[] {
  const details: string[] = [];
  if (checkMetadata) {
    if (
      expected.mode !== undefined &&
      actual.mode !== undefined &&
      expected.mode !== actual.mode
    ) {
      details.push(
        `Permissions ${toOctal(expected.mode)} → ${toOctal(actual.mode)}.`,
      );
    }
    if (
      expected.uid !== undefined &&
      actual.uid !== undefined &&
      expected.uid !== actual.uid
    ) {
      details.push(
        `Owner uid ${String(expected.uid)} → ${String(actual.uid)}.`,
      );
    }
    if (
      expected.gid !== undefined &&
      actual.gid !== undefined &&
      expected.gid !== actual.gid
    ) {
      details.push(
        `Owner gid ${String(expected.gid)} → ${String(actual.gid)}.`,
      );
    }
  }
  if (checkMtime && expected.mtimeMs !== actual.mtimeMs) {
    details.push(
      `Modification time ${isoOrRaw(expected.mtimeMs)} → ${isoOrRaw(actual.mtimeMs)} with identical contents.`,
    );
  }
  return details;
}

function snapshot(entry: BaselineEntry): FindingSnapshot {
  return {
    type: entry.type,
    size: entry.size,
    sha256: entry.sha256,
    mtimeMs: entry.mtimeMs,
    ...(entry.mode === undefined ? {} : { mode: entry.mode }),
    ...(entry.uid === undefined ? {} : { uid: entry.uid }),
    ...(entry.gid === undefined ? {} : { gid: entry.gid }),
  };
}

function toOctal(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`;
}

function isoOrRaw(mtimeMs: number): string {
  const date = new Date(mtimeMs);
  return Number.isNaN(date.getTime()) ? String(mtimeMs) : date.toISOString();
}

const CHANGE_ORDER: readonly ChangeType[] = [
  'type-changed',
  'modified',
  'removed',
  'added',
  'metadata',
  'unreadable',
];

function compareChange(left: ChangeType, right: ChangeType): number {
  return CHANGE_ORDER.indexOf(left) - CHANGE_ORDER.indexOf(right);
}
