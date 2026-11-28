import assert from 'node:assert/strict';
import test from 'node:test';
// The editor stays plain JavaScript; load its pure helpers directly.
const web = (name: string) => new URL(`../../../packages/web/${name}`, import.meta.url).href;
const { saveRetryDelay, SAVE_RETRY_DELAYS } = await import(web('save-retry.js'));
const { lineOffsets, lineAt, countAtMost } = await import(web('qmd-scan.js'));

test('autosave retries back off 1s, 2s, 4s, 8s and then stop', () => {
  assert.deepEqual([...SAVE_RETRY_DELAYS], [1000, 2000, 4000, 8000]);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(n => saveRetryDelay(n)), [1000, 2000, 4000, 8000, null, null]);
  assert.equal(saveRetryDelay(0), null);
  assert.equal(saveRetryDelay(1, 500), 1000);
});

test('autosave does not retry while the app is shutting down (503)', () => {
  assert.equal(saveRetryDelay(1, 503), null);
  assert.equal(saveRetryDelay(3, 503), null);
});

test('line lookup by binary search matches counting newlines before the offset', () => {
  const naive = (text: string, pos: number) => text.slice(0, pos).split('\n').length - 1;
  const samples = ['', 'a', '\n', 'abc\n', '\n\nx\n\n', '---\ntitle: t\n---\n\n## One\n\nbody\n\n## Two\n', 'あい\nう\n\n🙂x\n'];
  let seed = 7;
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 40; k++) samples.push(Array.from({ length: rand(60) }, () => 'ab\n #'[rand(5)]).join(''));
  for (const text of samples) {
    const lines = text.split('\n'), starts = lineOffsets(lines);
    assert.equal(starts.length, lines.length + 1);
    lines.forEach((line: string, i: number) => {
      assert.equal(starts[i], text.split('\n').slice(0, i).reduce((n: number, l: string) => n + l.length + 1, 0));
      // the end of a line (just before its newline) is starts[i + 1] - 1
      assert.equal(starts[i + 1] - 1, starts[i] + line.length);
    });
    for (let pos = 0; pos <= text.length + 2; pos++) assert.equal(lineAt(starts, pos), naive(text, pos), `${JSON.stringify(text)} @${pos}`);
  }
});

test('countAtMost counts sorted values not above x', () => {
  const xs = [0, 3, 3, 7, 10];
  assert.deepEqual([-1, 0, 2, 3, 6, 7, 9, 10, 11].map(x => countAtMost(xs, x)), [0, 1, 1, 3, 3, 4, 4, 5, 5]);
  assert.equal(countAtMost([], 5), 0);
});
