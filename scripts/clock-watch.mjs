// TEST harness aid (test:field): what the database clock did while requests were in flight.
// A local VM's database clock can step back (observed: about 1 s on colima); the server's
// fail-closed clock policy then answers RETRY, and a decision taken on the stepped-back clock
// sees less of the recent past. This module only records samples of `clock_timestamp()` taken
// from a separate connection; it never influences what the server decides. Host times are
// `performance.now()` milliseconds, database times epoch milliseconds.

/**
 * A probe whose samples are further apart than this cannot place a step-back precisely enough;
 * its intervals never explain a RETRY (the harness then fails as before).
 */
export const MAX_SAMPLE_GAP_MS = 500;

/**
 * Feed it samples in order with `record(start, end, db)`: the host time before the query was
 * sent, the host time its answer arrived, and the database time it returned.
 *
 * A sample is behind when its database time is below the highest one seen. The step-back
 * happened after the previous sample's query was sent, so its interval starts there; it ends
 * when a sample is no longer behind, plus the gap around the step (the clock may have read up to
 * that much more than the probe saw before it stepped back, so it may stay behind that long).
 */
export function createClockWatch() {
  let max = -Infinity;
  let previous = null;
  let open = null;
  let lastStart = -Infinity;
  const intervals = [];
  return {
    record(start, end, db) {
      if (db < max) {
        if (open) open.size = Math.max(open.size, max - db);
        else {
          open = {
            from: previous.start,
            to: Infinity,
            size: max - db,
            gap: end - previous.start,
          };
          intervals.push(open);
        }
      } else if (open) {
        open.to = end + open.gap;
        open = null;
      }
      max = Math.max(max, db);
      previous = { start, end };
      lastStart = start;
    },
    /** True while the latest sample is behind the highest database time seen. */
    behind: () => open !== null,
    /** Host time the latest sample was sent (to know a later step-back has been looked for). */
    lastSampleStart: () => lastStart,
    /** Whether an observed step-back overlaps the host-time window [from, to]. */
    overlaps(from, to) {
      return intervals.some(
        (i) => i.gap <= MAX_SAMPLE_GAP_MS && i.from <= to && from <= i.to,
      );
    },
    /** Step-backs whose interval reaches `since` or later: how many, and the largest (ms). */
    summary(since = -Infinity) {
      const seen = intervals.filter((i) => i.to >= since);
      return {
        count: seen.length,
        maxMs: Math.round(Math.max(0, ...seen.map((i) => i.size))),
      };
    },
  };
}
