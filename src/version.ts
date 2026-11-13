/**
 * The installed version.
 *
 * Read from the package manifest that ships beside the compiled code rather
 * than written into a constant, so `integrity --version` always reports what
 * is actually installed and cannot drift from the published release.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FALLBACK_VERSION = '0.0.0-unknown';

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled to dist/version.js, so the manifest is one level up; running
  // from source puts it one level up from src/ as well.
  const candidates = [
    join(here, '..', 'package.json'),
    join(here, '..', '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'name' in parsed &&
        'version' in parsed
      ) {
        const { name, version } = parsed;
        if (name === 'integrity' && typeof version === 'string') {
          return version;
        }
      }
    } catch {
      continue;
    }
  }
  return FALLBACK_VERSION;
}

/** The version of the installed package. */
export const VERSION: string = readVersion();

/** Product name as shown in help and reports. */
export const PRODUCT_NAME = 'Integrity';

/** One-line product description. */
export const PRODUCT_SUBTITLE = 'File Integrity Monitoring Toolkit';
