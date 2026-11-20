/** Byte count. Plain numbers are bytes. Strings use binary (KiB = 1024) or decimal (KB = 1000) units. */
export type ByteUnit = 'B' | 'KB' | 'MB' | 'GB' | 'TB' | 'KiB' | 'MiB' | 'GiB' | 'TiB';
export type ByteSize = number | `${number}${ByteUnit}`;

/** Duration. Plain numbers are milliseconds. */
export type DurationUnit = 'ms' | 's' | 'm' | 'h' | 'd';
export type Duration = number | `${number}${DurationUnit}`;

/** Unix epoch milliseconds. */
export type EpochMs = number;

const BYTE_UNITS: Record<ByteUnit, number> = {
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};

const DURATION_UNITS: Record<DurationUnit, number> = { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 };

/** Parses a {@link ByteSize} into a number of bytes. Throws on malformed input. */
export function parseBytes(value: ByteSize): number {
  if (typeof value === 'number') return assertFinite(value, value);
  const match = /^\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)\s*$/.exec(value);
  if (!match) throw new TypeError(`Invalid byte size: ${JSON.stringify(value)}`);
  return Math.round(Number(match[1]) * BYTE_UNITS[match[2] as ByteUnit]);
}

/** Parses a {@link Duration} into milliseconds. Throws on malformed input. */
export function parseDuration(value: Duration): number {
  if (typeof value === 'number') return assertFinite(value, value);
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/.exec(value);
  if (!match) throw new TypeError(`Invalid duration: ${JSON.stringify(value)}`);
  return Math.round(Number(match[1]) * DURATION_UNITS[match[2] as DurationUnit]);
}

function assertFinite(n: number, original: unknown): number {
  if (!Number.isFinite(n) || n < 0)
    throw new TypeError(`Expected a non-negative finite number, got ${String(original)}`);
  return n;
}

/** Human-readable binary size, for messages (`1.5 GiB`). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'] as const;
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}
