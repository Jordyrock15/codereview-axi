import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERLAY_SHOW_DELAY_MS, OVERLAY_MIN_VISIBLE_MS, overlayVisible, remainingVisibleMs,
} from '../../src/server/public/overlay.js';

test('overlayVisible stays hidden before the show-delay has elapsed', () => {
  assert.equal(overlayVisible({ elapsedMs: 0, finished: false }), false);
  assert.equal(overlayVisible({ elapsedMs: OVERLAY_SHOW_DELAY_MS - 1, finished: false }), false);
});

test('overlayVisible reveals once the show-delay has elapsed and the work is still going', () => {
  assert.equal(overlayVisible({ elapsedMs: OVERLAY_SHOW_DELAY_MS, finished: false }), true);
  assert.equal(overlayVisible({ elapsedMs: OVERLAY_SHOW_DELAY_MS + 500, finished: false }), true);
});

test('overlayVisible never reveals once the work has finished, however long it ran', () => {
  assert.equal(overlayVisible({ elapsedMs: OVERLAY_SHOW_DELAY_MS, finished: true }), false);
  assert.equal(overlayVisible({ elapsedMs: 10_000, finished: true }), false);
});

test('overlayVisible honours a custom show-delay', () => {
  assert.equal(overlayVisible({ elapsedMs: 40, finished: false, showDelayMs: 50 }), false);
  assert.equal(overlayVisible({ elapsedMs: 50, finished: false, showDelayMs: 50 }), true);
});

test('remainingVisibleMs is the full minimum when the overlay has just appeared', () => {
  assert.equal(remainingVisibleMs(0), OVERLAY_MIN_VISIBLE_MS);
});

test('remainingVisibleMs counts down as the overlay stays visible', () => {
  assert.equal(remainingVisibleMs(50), OVERLAY_MIN_VISIBLE_MS - 50);
});

test('remainingVisibleMs floors at zero once the minimum has already elapsed, never going negative', () => {
  assert.equal(remainingVisibleMs(OVERLAY_MIN_VISIBLE_MS), 0);
  assert.equal(remainingVisibleMs(OVERLAY_MIN_VISIBLE_MS + 1_000), 0);
});

test('remainingVisibleMs honours a custom minimum', () => {
  assert.equal(remainingVisibleMs(10, 30), 20);
});
