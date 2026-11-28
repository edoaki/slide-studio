import assert from 'node:assert/strict';
import test from 'node:test';
// The renderer stays plain JavaScript; load its pure helpers directly.
const web = (name: string) => new URL(`../../../packages/web/${name}`, import.meta.url).href;
const { fitPanelWidths, panelRange, PANEL_LIMITS } = await import(web('panel-widths.js'));
const { keyLabel, MAC_KEYS } = await import(web('strings.js'));

test('panel widths keep their preferred size when the window is wide enough', () => {
  assert.deepEqual(fitPanelWidths({ total: 1600, editor: 420, chat: 360 }), { editor: 420, chat: 360 });
  assert.deepEqual(fitPanelWidths({ total: 1600, editor: 100, chat: 100 }), { editor: PANEL_LIMITS.editorMin, chat: PANEL_LIMITS.chatMin });
  assert.deepEqual(fitPanelWidths({ total: 1600, editor: 420, chat: 360, chatOn: false }), { editor: 420, chat: 0 });
});

test('narrow windows shrink the side panels so the slide keeps its minimum width', () => {
  for (const total of [900, 1000, 1100, 1200]) {
    const { editor, chat } = fitPanelWidths({ total, editor: 600, chat: 500 });
    assert.ok(total - editor - chat >= PANEL_LIMITS.center, `${total}: ${editor} + ${chat}`);
    assert.ok(editor >= PANEL_LIMITS.editorMin && chat >= PANEL_LIMITS.chatMin, `${total}: ${editor} + ${chat}`);
  }
  // Slack is taken from both panels in proportion to how far they are above their minimums.
  assert.deepEqual(fitPanelWidths({ total: 1100, editor: 420, chat: 360 }), { editor: 405, chat: 354 });
  // Below the sum of minimums (for example at a large UI zoom) both panels scale down together.
  const zoomed = fitPanelWidths({ total: 600, editor: 420, chat: 360 });
  assert.ok(600 - zoomed.editor - zoomed.chat >= PANEL_LIMITS.center - 1);
  assert.ok(zoomed.editor > 0 && zoomed.chat > 0);
  // With one panel closed the other may use the room.
  assert.deepEqual(fitPanelWidths({ total: 900, editor: 600, chat: 360, chatOn: false }), { editor: 560, chat: 0 });
});

test('the drag and keyboard range leaves the slide its minimum width', () => {
  assert.deepEqual(panelRange('editor', { total: 1600, other: 360 }), { min: PANEL_LIMITS.editorMin, max: 900 });
  assert.deepEqual(panelRange('chat', { total: 1000, other: 420 }), { min: PANEL_LIMITS.chatMin, max: 300 });
  assert.deepEqual(panelRange('editor', { total: 800, other: 360 }), { min: PANEL_LIMITS.editorMin, max: PANEL_LIMITS.editorMin });
});

test('key labels switch to Ctrl, Alt and Shift outside macOS only', () => {
  assert.equal(MAC_KEYS, true, 'Node has no document, so strings stay as written');
  assert.equal(keyLabel('⇧ ⌘ Z', true), '⇧ ⌘ Z');
  assert.equal(keyLabel('⌘ Z', false), 'Ctrl Z');
  assert.equal(keyLabel('⇧ ⌘ Z', false), 'Shift Ctrl Z');
  assert.equal(keyLabel('⌘⇧. ⌘⇧,', false), 'Ctrl+Shift+. Ctrl+Shift+,');
  assert.equal(keyLabel('（⌘Z で取り消せる）', false), '（Ctrl+Z で取り消せる）');
  assert.equal(keyLabel('⌥ を押しながら', false), 'Alt を押しながら');
  assert.equal(keyLabel('Delete ⌫', false), 'Delete Backspace');
  assert.equal(keyLabel('Esc', false), 'Esc');
  assert.equal(keyLabel(undefined, false), undefined);
});
