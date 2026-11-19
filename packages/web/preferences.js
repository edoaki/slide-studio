import { api, toast } from './api.js';
let value = { theme: 'system', zoom: 100, keyHints: true, tooltips: true, tooltipKeys: true };
let nativeZoom = false, queue = Promise.resolve();
export const preferences = () => ({ ...value });
function apply() {
  const root = document.documentElement;
  root.dataset.theme = value.theme;
  root.dataset.keyHints = String(value.keyHints);
  root.dataset.tooltips = String(value.tooltips);
  root.dataset.tooltipKeys = String(value.tooltipKeys);
  root.style.setProperty('--ui-zoom', nativeZoom ? '1' : String(value.zoom / 100));
  root.style.zoom = nativeZoom ? '' : String(value.zoom / 100);
  window.dispatchEvent(new Event('studio-settings-change'));
  window.dispatchEvent(new Event('resize'));
}
export async function loadPreferences() {
  const data = await api('/api/settings');
  value = data.settings; nativeZoom = data.nativeZoom; apply();
}
export function savePreferences(patch) {
  const task = queue.then(async () => {
    const data = await api('/api/settings', { method: 'POST', body: typeof patch === 'function' ? patch(value) : patch });
    value = data.settings; nativeZoom = data.nativeZoom; apply();
  });
  queue = task.catch(e => toast(e.message));
  return task;
}
