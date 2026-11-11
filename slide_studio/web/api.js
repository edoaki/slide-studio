// サーバーとのやりとり（JSON と SSE）。
export const locationHeaders = () => ({
  'X-Slide-Studio-Location': document.querySelector('meta[name=slide-studio-location]')?.content || '',
});
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...locationHeaders() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new Error(data?.error || `${res.status}`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

// SSE を1本だけ開き、種類ごとに配る。窓が開いている印にもなるので、どの画面でもすぐ開く（lifeline.py）
const listeners = new Set();
const source = new EventSource('/api/events');
source.onmessage = e => { const ev = JSON.parse(e.data); for (const f of listeners) f(ev); };
export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const $ = (s, r = document) => r.querySelector(s);
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let toastTimer = 0;
export function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

export function sha256(text) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    .then(buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''));
}
