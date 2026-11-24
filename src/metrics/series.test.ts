import { test } from "node:test";
import assert from "node:assert/strict";
import { downsample, MAX_POINTS, metricItem, minStepSeconds, NO_DATA, sparkline, stats } from "./series";

const win = (ms: number) => ({ from: new Date(0), to: new Date(ms) });

test("step keeps every window within 60 points", () => {
  for (const seconds of [1, 59, 60, 900, 3600, 6 * 3600, 86_400, 7 * 86_400]) {
    const step = minStepSeconds(win(seconds * 1000));
    assert.ok(step >= 15 && step % 15 === 0, `step ${step} for ${seconds}s`);
    assert.ok(Math.floor(seconds / step) + 1 <= MAX_POINTS, `${seconds}s at ${step}s`);
  }
  assert.equal(minStepSeconds(win(3600_000)), 75);
});

test("downsample averages buckets and leaves short series alone", () => {
  assert.deepEqual(downsample([1, 2, 3], 30), [1, 2, 3]);
  const out = downsample(Array.from({ length: 60 }, (_, i) => i), 30);
  assert.equal(out.length, 30);
  assert.deepEqual(out.slice(0, 2), [0.5, 2.5]);
});

test("sparkline spans the bar range, flat series is mid-height, single point is empty", () => {
  assert.equal(sparkline([0, 1, 2, 3, 4, 5, 6, 7]), "▁▂▃▄▅▆▇█");
  assert.equal(sparkline([5, 5, 5]), "▄▄▄");
  assert.equal(sparkline([5]), "");
});

test("stats round to 4 significant digits", () => {
  assert.deepEqual(stats([1, 2, 4.123456]), { min: 1, max: 4.123, avg: 2.374, last: 4.123 });
  assert.deepEqual(stats([]), { min: null, max: null, avg: null, last: null });
});

test("metricItem: at most 30 points, nulls with a note when the series is missing", () => {
  const series = { labels: {}, points: Array.from({ length: 60 }, (_, i): [number, number] => [i, i]) };
  const item = metricItem("cpu", "cores", series);
  assert.equal(item.points.length, 30);
  assert.equal(item.sparkline.length, 30);
  assert.equal(item.last, 59);
  assert.equal(item.note, undefined);
  assert.deepEqual(metricItem("cpu", "cores", undefined), { metric: "cpu", unit: "cores", min: null, max: null, avg: null, last: null, points: [], sparkline: "", note: NO_DATA });
  assert.equal(metricItem("x", "u", { labels: {}, points: [] }, "custom").note, "custom");
});
