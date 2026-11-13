/**
 * Shared formatting helpers.
 *
 * Filenames come from the filesystem, which means they are attacker-
 * controlled on any machine worth monitoring. A file called
 * `\u001B[2K\rAll files verified` would otherwise be able to rewrite the
 * line above it in a terminal and fake a clean result, so every path is
 * passed through `escapeControlCharacters` before it is printed. Unicode
 * filenames stay readable; only control characters are escaped.
 */

/** Replaces control characters with visible `\xNN` / `\uNNNN` escapes. */
export function escapeControlCharacters(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
      continue;
    }
    // C1 controls and the bidirectional overrides used for filename spoofing.
    if ((code >= 0x80 && code <= 0x9f) || (code >= 0x202a && code <= 0x202e)) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += char;
  }
  return out;
}

/** Formats a byte count for humans without inventing precision. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? 'B'}`;
}

/** Formats a duration in milliseconds. */
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${String(Math.round(milliseconds))} ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${String(minutes)} m ${String(rest)} s`;
}

/** Pluralises a count with its noun. */
export function plural(
  count: number,
  singular: string,
  pluralForm?: string,
): string {
  const word = count === 1 ? singular : (pluralForm ?? `${singular}s`);
  return `${String(count)} ${word}`;
}
