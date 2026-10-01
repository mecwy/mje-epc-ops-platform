import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClockWatch, FRESH_MS } from './clock-watch.mjs';

/** Samples every 10 ms of host time, 2 ms round trip; `db(t)` gives the database time. */
function feed(watch, from, to, db) {
  for (let t = from; t < to; t += 10) watch.record(t, t + 2, db(t));
}

test('a monotonic clock never holds anything back and reports nothing', () => {
  const w = createClockWatch();
  assert.equal(w.hold(0), false, 'no samples');
  feed(w, 0, 5_000, (t) => 1e12 + t);
  assert.equal(w.hold(4_995), false);
  assert.deepEqual(w.summary(), { count: 0, maxMs: 0, maxGapMs: 0 });
});

test('a step back holds while fresh samples are behind and releases once the clock reaches what it showed', () => {
  const w = createClockWatch();
  // At host 1000 the database clock steps back 800 ms.
  const db = (t) => 1e12 + t - (t >= 1_000 ? 800 : 0);
  feed(w, 0, 1_000, db);
  assert.equal(w.hold(995), false, 'the step has not been sampled yet');
  feed(w, 1_000, 1_500, db);
  assert.equal(w.hold(1_495), true);
  // Released at the first sample at or above the highest database time seen (host 1790):
  // the clock then reads what it read before the step, never more.
  feed(w, 1_500, 1_790, db);
  assert.equal(w.hold(1_785), true);
  feed(w, 1_790, 1_800, db);
  assert.equal(w.hold(1_795), false);
  assert.equal(db(1_790), db(990));
  feed(w, 1_800, 3_000, db);
  const s = w.summary();
  assert.equal(s.count, 1);
  assert.ok(Math.abs(s.maxMs - 800) <= 10);
  assert.equal(s.maxGapMs, 12);
  assert.equal(w.summary(2_000).count, 0, 'not reported for a later step');
});

test('a stale sample never holds: a stalled probe gives no information', () => {
  const w = createClockWatch();
  w.record(0, 2, 1e12);
  w.record(10, 12, 1e12 - 300);
  assert.equal(w.hold(12 + FRESH_MS), true);
  assert.equal(w.hold(13 + FRESH_MS), false);
});

test('a stall after the step opened or before it closed widens the reported gap', () => {
  const w = createClockWatch();
  w.record(0, 2, 1e12);
  w.record(10, 12, 1e12 - 300);
  w.record(810, 812, 1e12 - 200); // stalled 800 ms while behind
  w.record(820, 822, 1e12 + 900); // caught up
  assert.equal(w.summary().maxGapMs, 802);
  const v = createClockWatch();
  v.record(0, 2, 1e12);
  v.record(10, 12, 1e12 - 300);
  v.record(1_500, 1_502, 1e12 + 1_500); // stalled, then caught up
  assert.equal(v.summary().maxGapMs, 1_492);
});
