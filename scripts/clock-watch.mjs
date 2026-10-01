// TEST harness aid (test:field): what the database clock did during the run. A local VM's
// database clock can step back (observed: about 1 s on colima); the server's fail-closed clock
// policy then answers RETRY, and a decision taken on the stepped-back clock sees less of the
// recent past. This module only records samples of `clock_timestamp()` taken from a separate
// connection; it never influences what the server decides and never explains a server answer.
// Host times are `performance.now()` milliseconds, database times epoch milliseconds.

/**
 * Feed it samples in order with `record(start, end, db)`: the host time before the query was
 * sent, the host time its answer arrived, and the database time it returned.
 *
 * A sample is behind when its database time is below the highest one seen. A step-back's
 * interval runs from the previous sample's start to the end of the first sample that is no
 * longer behind; `gap` is the widest distance between consecutive samples over that whole
 * interval (a stall while it is open or before it closes widens it).
 */
export function createClockWatch() {
  let max = -Infinity;
  let previous = null;
  let open = null;
  const intervals = [];
  return {
    record(start, end, db) {
      const gap = previous ? end - previous.start : 0;
      if (db < max) {
        if (open) {
          open.size = Math.max(open.size, max - db);
          open.gap = Math.max(open.gap, gap);
        } else {
          open = { from: previous.start, to: Infinity, size: max - db, gap };
          intervals.push(open);
        }
      } else if (open) {
        open.gap = Math.max(open.gap, gap);
        open.to = end;
        open = null;
      }
      max = Math.max(max, db);
      previous = { start, end };
    },
    /** Step-backs whose interval reaches `since` or later: how many, the largest, widest gap (ms). */
    summary(since = -Infinity) {
      const seen = intervals.filter((i) => i.to >= since);
      return {
        count: seen.length,
        maxMs: Math.round(Math.max(0, ...seen.map((i) => i.size))),
        maxGapMs: Math.round(Math.max(0, ...seen.map((i) => i.gap))),
      };
    },
  };
}
