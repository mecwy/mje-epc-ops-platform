import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClockWatch, MAX_SAMPLE_GAP_MS } from './clock-watch.mjs';

/** Samples every 10 ms of host time, 2 ms round trip; `db(t)` gives the database time. */
function feed(watch, from, to, db) {
  for (let t = from; t < to; t += 10) watch.record(t, t + 2, db(t));
}

test('a monotonic clock explains nothing and never holds anything back', () => {
  const w = createClockWatch();
  feed(w, 0, 5_000, (t) => 1e12 + t);
  assert.equal(w.behind(), false);
  assert.equal(w.overlaps(0, 5_000), false);
  assert.deepEqual(w.summary(), { count: 0, maxMs: 0 });
});

test('a step back is behind until the clock passes what it showed, and explains only overlapping requests', () => {
  const w = createClockWatch();
  // At host 1000 the database clock steps back 800 ms.
  const db = (t) => 1e12 + t - (t >= 1_000 ? 800 : 0);
  feed(w, 0, 1_000, db);
  assert.equal(w.behind(), false, 'the step has not been sampled yet');
  feed(w, 1_000, 1_500, db);
  assert.equal(w.behind(), true);
  assert.equal(w.overlaps(1_400, 1_450), true, 'still open');
  feed(w, 1_500, 3_000, db);
  assert.equal(w.behind(), false);
  // Behind from just after the last sample before the step until about 1800 (+ the gap).
  assert.equal(w.overlaps(995, 1_001), true);
  assert.equal(w.overlaps(1_790, 1_795), true);
  assert.equal(
    w.overlaps(0, 980),
    false,
    'a request that ended before the step',
  );
  assert.equal(w.overlaps(1_850, 2_000), false, 'a request after it caught up');
  assert.equal(w.summary().count, 1);
  assert.ok(Math.abs(w.summary().maxMs - 800) <= 10);
  assert.equal(w.summary(2_000).count, 0, 'not reported for a later step');
});

test('a step smaller than the sampling interval is not seen, so it explains nothing', () => {
  const w = createClockWatch();
  feed(w, 0, 2_000, (t) => 1e12 + t - (t >= 1_000 ? 5 : 0));
  assert.equal(w.overlaps(0, 2_000), false);
});

test('a stalled probe cannot place a step back, so it explains nothing', () => {
  const w = createClockWatch();
  w.record(0, 2, 1e12);
  w.record(MAX_SAMPLE_GAP_MS + 100, MAX_SAMPLE_GAP_MS + 102, 1e12 - 300);
  assert.equal(w.behind(), true, 'still held back');
  w.record(5_000, 5_002, 1e12 + 5_000);
  assert.equal(w.overlaps(0, 5_000), false);
  assert.equal(w.summary().count, 1, 'but still reported');
});

test('lastSampleStart tells whether a step after a request could have been seen', () => {
  const w = createClockWatch();
  assert.equal(w.lastSampleStart(), -Infinity);
  w.record(40, 42, 1e12);
  assert.equal(w.lastSampleStart(), 40);
});
