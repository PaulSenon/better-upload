/** Byte count. Plain numbers are bytes. Strings use binary (KiB=1024) or decimal (KB=1000) units. */
export type ByteUnit = 'B' | 'KB' | 'MB' | 'GB' | 'TB' | 'KiB' | 'MiB' | 'GiB' | 'TiB';
export type ByteSize = number | `${number}${ByteUnit}`;

/** Duration. Plain numbers are milliseconds. */
export type DurationUnit = 'ms' | 's' | 'm' | 'h' | 'd';
export type Duration = number | `${number}${DurationUnit}`;

/** Unix epoch milliseconds. */
export type EpochMs = number;
