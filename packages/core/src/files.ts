import type { FileRules } from './contract.js';
import { UploadError } from './errors.js';
import type { FileDescriptor } from './protocol.js';
import { formatBytes, parseBytes } from './units.js';

/**
 * Does a file match an `accept` list? Patterns: exact MIME (`video/mp4`), wildcard (`image/*`), extension (`.heic`).
 * Browsers often report an empty `type` (e.g. `.heic` on some platforms), which is why extensions are supported.
 */
export function matchesAccept(
  file: Pick<FileDescriptor, 'name' | 'type'>,
  accept: readonly string[] | undefined,
): boolean {
  if (!accept || accept.length === 0) return true;
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return accept.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (pattern === '*' || pattern === '*/*') return true;
    if (pattern.startsWith('.')) return name.endsWith(pattern);
    if (pattern.endsWith('/*')) return type.startsWith(pattern.slice(0, -1));
    return type === pattern;
  });
}

/** Validates one file against the rules. Returns the first violation, or `undefined`. */
export function checkFile(file: FileDescriptor, rules: FileRules): UploadError | undefined {
  if (!matchesAccept(file, rules.accept)) {
    return UploadError.builtin('FILE_TYPE_NOT_ALLOWED', {
      message: `"${file.name}" (${file.type || 'unknown type'}) is not allowed. Accepted: ${rules.accept?.join(', ')}`,
    });
  }
  if (rules.maxFileSize !== undefined) {
    const max = parseBytes(rules.maxFileSize);
    if (file.size > max) {
      return UploadError.builtin('FILE_TOO_LARGE', {
        message: `"${file.name}" is ${formatBytes(file.size)}; the limit is ${formatBytes(max)}`,
        data: { limit: max, actual: file.size },
      });
    }
  }
  if (rules.minFileSize !== undefined) {
    const min = parseBytes(rules.minFileSize);
    if (file.size < min) {
      return UploadError.builtin('FILE_TOO_SMALL', {
        message: `"${file.name}" is ${formatBytes(file.size)}; the minimum is ${formatBytes(min)}`,
        data: { limit: min, actual: file.size },
      });
    }
  }
  return undefined;
}

/** Validates a whole batch (count, total size, then each file). */
export function checkFiles(files: readonly FileDescriptor[], rules: FileRules): UploadError | undefined {
  const maxFiles = rules.maxFiles ?? 1;
  if (files.length === 0) return UploadError.builtin('BAD_REQUEST', { message: 'No file given' });
  if (files.length > maxFiles) {
    return UploadError.builtin('TOO_MANY_FILES', {
      message: `${files.length} files given; at most ${maxFiles} allowed`,
      data: { limit: maxFiles, actual: files.length },
    });
  }
  if (rules.maxTotalSize !== undefined) {
    const max = parseBytes(rules.maxTotalSize);
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > max) {
      return UploadError.builtin('FILE_TOO_LARGE', {
        message: `The batch is ${formatBytes(total)}; the limit is ${formatBytes(max)}`,
        data: { limit: max, actual: total },
      });
    }
  }
  for (const file of files) {
    const error = checkFile(file, rules);
    if (error) return error;
  }
  return undefined;
}

/** `accept` attribute for `<input type="file">`. */
export function acceptAttribute(rules: FileRules | undefined): string | undefined {
  return rules?.accept?.length ? rules.accept.join(',') : undefined;
}
