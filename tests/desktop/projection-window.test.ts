import assert from 'node:assert/strict';
import test from 'node:test';
import { projectionPlacement, type DisplayArea } from '../../apps/desktop/projection-window.js';

const display = (id: number, x: number, width: number, height: number, menu = 0): DisplayArea => ({
  id, bounds: { x, y: 0, width, height }, workArea: { x, y: menu, width, height: height - menu },
});

test('a single display keeps the projection window in the lower-right quarter', () => {
  const main = display(1, 0, 1440, 900, 25);
  assert.deepEqual(projectionPlacement([main], main), {
    bounds: { x: 720, y: 25 + 438, width: 720, height: 437 }, external: false,
  });
});

test('with another display the projection window fills it, never the main window display', () => {
  const laptop = display(1, 0, 1512, 982, 38), projector = display(2, 1512, 1920, 1080);
  assert.deepEqual(projectionPlacement([laptop, projector], laptop), { bounds: projector.workArea, external: true });
  // The main window may sit on the external monitor; then the other display is used.
  assert.deepEqual(projectionPlacement([laptop, projector], projector), { bounds: laptop.workArea, external: true });
});

test('with several other displays the largest one is chosen', () => {
  const main = display(1, 0, 1440, 900), small = display(2, -1280, 1280, 800), large = display(3, 1440, 3840, 2160);
  assert.equal(projectionPlacement([main, small, large], main).bounds.x, 1440);
  assert.equal(projectionPlacement([small, main, large], large).bounds.x, 0);
});
