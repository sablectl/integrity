/**
 * Human-readable verification reports.
 *
 * The report answers three questions in order, because that is the order an
 * operator asks them in: can the baseline be trusted, what changed, and was
 * anything left unchecked. A run with unreadable files never prints a clean
 * verdict, no matter how few findings it had.
 */
import type { Finding, Severity, VerificationReport } from '../core/verify.js';
import type { Terminal, Style } from '../cli/terminal.js';
import { escapeControlCharacters, formatDuration, plural } from './format.js';

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
  info: 'INFO',
};

const SEVERITY_STYLE: Record<Severity, Style> = {
  critical: 'magenta',
  high: 'red',
  medium: 'yellow',
  low: 'cyan',
  info: 'dim',
};

const CHANGE_LABEL = {
  added: 'added',
  removed: 'removed',
  modified: 'modified',
  'type-changed': 'type changed',
  metadata: 'metadata',
  unreadable: 'unreadable',
} as const;

export interface HumanReportOptions {
  /** Print the recorded and observed digests for each finding. */
  readonly detailed?: boolean;
  /** Suppress the per-finding list and print only the summary. */
  readonly summaryOnly?: boolean;
}

/** Writes a verification report to the terminal. */
export function renderReport(
  terminal: Terminal,
  report: VerificationReport,
  options: HumanReportOptions = {},
): void {
  terminal.out(terminal.style('Integrity verification', 'bold'));
  terminal.out(`  Root        ${escapeControlCharacters(report.root)}`);
  if (report.baselinePath !== undefined) {
    terminal.out(
      `  Baseline    ${escapeControlCharacters(report.baselinePath)}`,
    );
  }
  terminal.out(`  Recorded    ${report.baselineCreatedAt}`);
  terminal.out(`  Checked     ${report.generatedAt}`);
  terminal.out(`  Trust       ${describeSignature(terminal, report)}`);
  terminal.out();

  if (!options.summaryOnly && report.findings.length > 0) {
    for (const finding of report.findings) {
      renderFinding(terminal, finding, options.detailed ?? false);
    }
    terminal.out();
  }

  renderSummary(terminal, report);
}

function renderFinding(
  terminal: Terminal,
  finding: Finding,
  detailed: boolean,
): void {
  const label = SEVERITY_LABEL[finding.severity].padEnd(8);
  const change = CHANGE_LABEL[finding.change].padEnd(12);
  terminal.out(
    `${terminal.style(label, SEVERITY_STYLE[finding.severity])} ${terminal.style(change, 'bold')} ${escapeControlCharacters(finding.path)}`,
  );
  for (const detail of finding.details) {
    terminal.out(`           ${escapeControlCharacters(detail)}`);
  }
  if (!detailed) return;
  if (finding.expected?.sha256 !== undefined) {
    terminal.out(
      terminal.style(`           recorded ${finding.expected.sha256}`, 'dim'),
    );
  }
  if (finding.actual?.sha256 !== undefined) {
    terminal.out(
      terminal.style(`           observed ${finding.actual.sha256}`, 'dim'),
    );
  }
}

function renderSummary(terminal: Terminal, report: VerificationReport): void {
  const { summary } = report;
  terminal.out(terminal.style('Summary', 'bold'));
  terminal.out(
    `  ${plural(summary.checked, 'baseline entry', 'baseline entries')} checked in ${formatDuration(report.durationMs)}`,
  );
  terminal.out(
    `  ${String(summary.unchanged)} unchanged, ${String(summary.modified)} modified, ${String(summary.added)} added, ${String(summary.removed)} removed`,
  );
  if (summary.typeChanged > 0 || summary.metadataChanged > 0) {
    terminal.out(
      `  ${String(summary.typeChanged)} type changed, ${String(summary.metadataChanged)} metadata changed`,
    );
  }
  if (summary.unreadable > 0) {
    terminal.out(
      terminal.style(
        `  ${plural(summary.unreadable, 'entry', 'entries')} could not be checked`,
        'yellow',
      ),
    );
  }
  terminal.out();
  terminal.out(verdict(terminal, report));
}

function verdict(terminal: Terminal, report: VerificationReport): string {
  switch (report.status) {
    case 'baseline-untrusted':
      return terminal.style(
        'BASELINE UNTRUSTED — the baseline failed its integrity check. Do not rely on this result.',
        'magenta',
        'bold',
      );
    case 'changes-detected':
      return terminal.style(
        report.complete
          ? 'CHANGES DETECTED'
          : 'CHANGES DETECTED — and some entries could not be checked.',
        'red',
        'bold',
      );
    case 'incomplete':
      return terminal.style(
        'INCOMPLETE — no changes were found, but some entries could not be checked. This is not a clean result.',
        'yellow',
        'bold',
      );
    case 'clean':
      return terminal.style(
        'OK — every recorded entry matches the baseline.',
        'green',
        'bold',
      );
  }
}

function describeSignature(
  terminal: Terminal,
  report: VerificationReport,
): string {
  const keyId =
    report.signature.keyId === undefined
      ? ''
      : ` (key ${report.signature.keyId})`;
  switch (report.signature.status) {
    case 'valid':
      return `${terminal.style('signed, verified', 'green')}${keyId}`;
    case 'invalid':
      return terminal.style(`signature check FAILED${keyId}`, 'magenta');
    case 'unverified':
      return terminal.style(
        `signed, not verified — no key supplied${keyId}`,
        'yellow',
      );
    case 'unsigned':
      return terminal.style(
        'unsigned — detects accidents, not an attacker who can also rewrite the baseline',
        'dim',
      );
  }
}
