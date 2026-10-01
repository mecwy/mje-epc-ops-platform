import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClockWatch } from './clock-watch.mjs';

/** Samples every 10 ms of host time, 2 ms round trip; `db(t)` gives the database time. */
function feed(watch, from, to, db) {
  for (let t = from; t < to; t += 10) watch.record(t, t + 2, db(t));
}

test('a monotonic clock reports nothing', () => {
  const w = createClockWatch();
  feed(w, 0, 5_000, (t) => 1e12 + t);
  assert.deepEqual(w.summary(), { count: 0, maxMs: 0, maxGapMs: 0 });
});

test('a step back is reported once, with its size, until the clock reaches what it showed', () => {
  const w = createClockWatch();
  // At host 1000 the database clock steps back 800 ms; it reads 990 again at host 1790.
  feed(w, 0, 3_000, (t) => 1e12 + t - (t >= 1_000 ? 800 : 0));
  const s = w.summary();
  assert.equal(s.count, 1);
  assert.ok(Math.abs(s.maxMs - 800) <= 10);
  assert.equal(s.maxGapMs, 12);
  assert.equal(w.summary(1_790).count, 1, 'reported for a step it reaches');
  assert.equal(w.summary(2_000).count, 0, 'not reported for a later step');
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
