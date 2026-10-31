import test from 'node:test';
import assert from 'node:assert/strict';
import { maximizedPlacement } from '../window-state.js';

test('desktop 放大 centres a window up to 1280px wide with a 24px margin', () => {
    assert.deepEqual(maximizedPlacement(1920, 1080), { width: 1280, height: 1032, x: 320, y: 24 });
    assert.deepEqual(maximizedPlacement(1000, 700), { width: 952, height: 652, x: 24, y: 24 });
});
