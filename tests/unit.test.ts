import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { splitMixerLoads } from '../src/domain/production.js';

describe('mixer load planning', () => {
  test('65 units in a 33 mixer becomes 32 + 33', () => {
    assert.deepEqual(splitMixerLoads(65, 33), [32, 33]);
  });

  test('a batch that fits in one load stays one load', () => {
    assert.deepEqual(splitMixerLoads(30, 33), [30]);
    assert.deepEqual(splitMixerLoads(33, 33), [33]);
  });

  test('loads are balanced and never exceed the mixer', () => {
    for (const total of [1, 34, 66, 67, 99, 100, 150]) {
      const loads = splitMixerLoads(total, 33);
      assert.equal(
        loads.reduce((a, b) => a + b, 0),
        total,
        `loads for ${total} must sum back to ${total}`,
      );
      assert.ok(Math.max(...loads) <= 33, `no load may exceed 33 (got ${loads})`);
      assert.ok(Math.max(...loads) - Math.min(...loads) <= 1, `loads must be balanced (got ${loads})`);
      assert.equal(loads.length, Math.ceil(total / 33), 'uses the fewest possible loads');
    }
  });

  test('nothing planned means no loads', () => {
    assert.deepEqual(splitMixerLoads(0, 33), []);
  });
});
