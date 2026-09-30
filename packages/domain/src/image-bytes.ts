/**
 * Byte-level helpers shared by the bounded image readers (photo-file) and the metadata
 * stripper (photo-strip). Internal to the domain package: not exported from its index.
 */

/** `n` bytes at `at` as Latin-1 text; '' when they are not all inside `b`. */
export const ascii = (b: Uint8Array, at: number, n: number) =>
  at < 0 || at + n > b.length
    ? ''
    : String.fromCharCode(...b.subarray(at, at + n));
/** Unsigned integers; callers bounds-check before reading. */
export const be16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
export const be32 = (b: Uint8Array, o: number) =>
  ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
export const le32 = (b: Uint8Array, o: number) =>
  ((b[o + 3]! << 24) >>> 0) + (b[o + 2]! << 16) + (b[o + 1]! << 8) + b[o]!;

/**
 * Every structural loop spends from one budget per file, so no structure (declared counts,
 * zero-size entries, many tiny boxes or segments) can make a reader work longer than a fixed
 * number of steps. A file that needs more is treated as unreadable. Real camera files use well
 * under a thousand steps.
 */
export const PARSE_STEPS = 10_000;
export class Exhausted extends Error {}
export class Budget {
  private left = PARSE_STEPS;
  step() {
    if (--this.left < 0) throw new Exhausted();
  }
}
