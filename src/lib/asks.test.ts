/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAsks } from './asks.ts';

test('only the latest ask’s answer counts, whichever comes back first', () => {
  const asks = createAsks();
  // My shop asks on focus, then again with Try again before the first answer.
  const first = asks.ask();
  const second = asks.ask();
  // The second comes back first and counts; the first, late, doesn't.
  assert.equal(second.latest(), true);
  assert.equal(first.latest(), false);
  assert.equal(asks.ask().latest(), true);
  assert.equal(second.latest(), false);
});

test('a photo changed after My shop asked is newer than that answer, but not than the next ask’s', () => {
  const asks = createAsks();
  const before = asks.ask();
  assert.equal(before.changedSince(), false);
  // The owner removes a photo while the slow answer is on its way.
  asks.changed();
  assert.deepEqual([before.latest(), before.changedSince()], [true, true]);
  // Asked again after the change: its answer has the photo gone, and is taken whole.
  const after = asks.ask();
  assert.deepEqual([after.latest(), after.changedSince()], [true, false]);
  asks.changed();
  asks.changed();
  assert.equal(after.changedSince(), true);
});
