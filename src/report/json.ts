/**
 * Machine-readable reports.
 *
 * The JSON report is a stable contract for scripts and CI pipelines: the
 * field names here change only with a major version. Findings are already
 * sorted by path, so two runs over an unchanged tree differ only in their
 * timestamps and measured duration.
 */
import { UsageError, describeError } from '../core/errors.js';
import type { VerificationReport } from '../core/verify.js';

/** Serializes a report as JSON with a trailing newline. */
export function serializeReport(
  report: VerificationReport,
  pretty = true,
): string {
  return `${JSON.stringify(report, null, pretty ? 2 : 0)}\n`;
}

/**
 * A single-line JSON object per event, for log pipelines that read one
 * record per line.
 */
export function toNdjsonLine(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Parses a previously saved report so it can be re-rendered.
 *
 * Only the fields the renderer depends on are checked: this is a convenience
 * for reading back the tool's own output, not a trust boundary, and it is
 * documented as such.
 */
export function parseReport(
  text: string,
  origin = '<stdin>',
): VerificationReport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new UsageError(
      `Report ${origin} is not valid JSON: ${describeError(error)}`,
    );
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new UsageError(`Report ${origin} must be a JSON object.`);
  }
  const record = data as Record<string, unknown>;
  for (const field of ['status', 'summary', 'findings', 'root'] as const) {
    if (!(field in record)) {
      throw new UsageError(
        `Report ${origin} is missing the "${field}" field.`,
        ['Expected a report produced by: integrity verify --json'],
      );
    }
  }
  if (!Array.isArray(record['findings'])) {
    throw new UsageError(`Report ${origin} has a malformed "findings" field.`);
  }
  return record as unknown as VerificationReport;
}
