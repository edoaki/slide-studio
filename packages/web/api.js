// サーバーとのやりとり（JSON と SSE）。
// 管理 UI の接続資格は起動時の URL 断片（#token=...）から取り出し、以後の再読み込みに
// 備えて同じ配信元の sessionStorage（slide-studio:admin-token）にも置く。URL には残さない。
// sessionStorage は同じ配信元の管理スクリプトだけが読める（スライドの内容 iframe は別配信元）。
// 同じ配信元で動くスクリプトは元々管理権限を持つため、「閉包だけ」を安全境界とはみなさない。
import { S } from './strings.js';

const TOKEN_KEY = 'token';
const TOKEN_STORAGE_KEY = 'slide-studio:admin-token';
const TOKEN_HEADER = 'X-Studio-Token';
const LOCATION_HEADER = 'X-Slide-Studio-Location';
const AUTH_STATUS = new Set([401, 403]);
const MAX_SSE_BUFFER = 4 * 1024 * 1024;
const MIN_RETRY_MS = 20;
const MAX_RETRY_MS = 30_000;

function decodeFragmentValue(value) {
  // token は base64 の + を含みうるため、form 形式の + → 空白変換はしない。
  try { return decodeURIComponent(value); } catch { return value; }
}

function readStoredToken() {
  try { return globalThis.sessionStorage?.getItem(TOKEN_STORAGE_KEY) || ''; } catch { return ''; }
}

function writeStoredToken(value) {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) return;
    // 保存に失敗しても古い資格を残さないよう、先に消してから新しい値を置く。
    storage.removeItem(TOKEN_STORAGE_KEY);
    if (value) storage.setItem(TOKEN_STORAGE_KEY, value);
  } catch {
    // 保存領域が使えなくても、この文書では閉包の token で動き続ける。
  }
}

function clearStoredToken() {
  try { globalThis.sessionStorage?.removeItem(TOKEN_STORAGE_KEY); } catch {
    // 保存領域が使えない場合は何もしない。
  }
}

// token だけを断片から外し、ほかの断片（旧来の #ページ/step など）はそのまま残す。
function takeTokenFromFragment(fragment) {
  const raw = String(fragment || '').replace(/^#/, '');
  if (!raw) return { token: '', found: false, fragment: '' };
  let token = null;
  const kept = [];
  for (const part of raw.split('&')) {
    const at = part.indexOf('=');
    const key = at < 0 ? part : part.slice(0, at);
    if (key === TOKEN_KEY) {
      if (token === null) token = decodeFragmentValue(at < 0 ? '' : part.slice(at + 1));
    } else if (part) {
      kept.push(part);
    }
  }
  return { token: token ?? '', found: token !== null, fragment: kept.join('&') };
}

const bootstrap = takeTokenFromFragment(location.hash);
// 新しい起動時の断片が保存済みの token を上書きする。断片が無い再読み込みでは保存済みを使う。
const token = bootstrap.found ? bootstrap.token : readStoredToken();

if (bootstrap.found) {
  writeStoredToken(token);
  try {
    const url = new URL(location.href);
    url.hash = bootstrap.fragment ? `#${bootstrap.fragment}` : '';
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // URL を書き換えられない環境でも、下のヘッダーには閉包の token だけを使う。
  }
}

const adminOrigin = (() => {
  try { return new URL(location.href).origin; } catch { return location.origin; }
})();
const adminProtocol = (() => {
  try { return new URL(location.href).protocol; } catch { return location.protocol; }
})();

function targetUrl(target) {
  // Request をそのまま String() にすると "[object Request]" になるため、.url を使う。
  return target && typeof target === 'object' && typeof target.url === 'string' ? target.url : target;
}

function sameAdminOrigin(target) {
  const value = targetUrl(target);
  if (value === undefined || value === null || value === '') return false;
  try {
    const url = new URL(String(value), location.href);
    return url.origin === adminOrigin && url.protocol === adminProtocol;
  } catch { return false; }
}

// token を付けるには、検証済みの明示的な送信先が要る。引数なしでは資格を付けない。
export const locationHeaders = target => {
  const headers = {
    [LOCATION_HEADER]: document.querySelector('meta[name=slide-studio-location]')?.content || '',
  };
  if (token && sameAdminOrigin(target)) headers[TOKEN_HEADER] = token;
  return headers;
};

function managementUrl(path) {
  const url = new URL(String(targetUrl(path)), location.href);
  if (url.origin !== adminOrigin || url.protocol !== adminProtocol) {
    throw new Error('管理 API はこのアプリの配信元とだけ通信できます。');
  }
  return url;
}

// 旧来のバイナリ送信を、api() と同じ送信元検証・資格・リダイレクト拒否を通す。
export async function uploadFetch(path, init = {}) {
  const url = managementUrl(path);
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(locationHeaders(url))) headers.set(name, value);
  const response = await fetch(url.href, {
    ...init,
    headers,
    credentials: 'omit',
    redirect: 'error',
  });
  if (AUTH_STATUS.has(response.status)) clearStoredToken();
  return response;
}

function errorMessage(response, data) {
  if (typeof data?.error === 'string' && data.error) return data.error;
  if (typeof data?.error?.message === 'string' && data.error.message) return data.error.message;
  if (AUTH_STATUS.has(response.status)) return S.authLost;
  return `${response.status}`;
}

export async function api(path, { method = 'GET', body } = {}) {
  const url = managementUrl(path);
  const res = await fetch(url.href, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...locationHeaders(url) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    if (AUTH_STATUS.has(res.status)) clearStoredToken();
    const err = new Error(errorMessage(res, data));
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

// SSE を1本だけ開き、種類ごとに配る。窓が開いている印にもなるので、どの画面でもすぐ開く（lifeline.py）
const listeners = new Set();
let streamController = null;
let reconnectTimer = 0;
let stopped = false;
let authLost = false;
let retryBase = 1000;
let retryDelay = retryBase;
let authNoticeShown = false;
let authNoticePending = false;
let authNoticeListening = false;

function deferAuthNotice() {
  if (authNoticeListening || typeof addEventListener !== 'function') return;
  authNoticeListening = true;
  addEventListener('DOMContentLoaded', () => {
    authNoticeListening = false;
    showAuthNotice();
  }, { once: true });
}

function showAuthNotice() {
  if (authNoticeShown || !authNoticePending) return;
  try {
    toast(S.authLost);
    authNoticeShown = true;
    authNoticePending = false;
  } catch {
    // 表示できなかった時点では「表示済み」にしない。DOM の準備後に呼び直す。
    deferAuthNotice();
  }
}

function notifyAuthLost() {
  if (authNoticeShown || authNoticePending) return;
  authNoticePending = true;
  if (typeof document !== 'undefined' && document.readyState === 'loading') deferAuthNotice();
  else showAuthNotice();
}

function scheduleReconnect() {
  if (reconnectTimer || stopped || authLost) return;
  const delay = Math.max(MIN_RETRY_MS, retryDelay);
  retryDelay = Math.min(Math.max(retryDelay * 2, MIN_RETRY_MS), MAX_RETRY_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = 0;
    startEventStream();
  }, delay);
}

function nextLine(buffer) {
  for (let i = 0; i < buffer.length; i += 1) {
    const ch = buffer[i];
    if (ch === '\n') return { line: buffer.slice(0, i), next: i + 1 };
    if (ch === '\r') {
      if (i === buffer.length - 1) return null;
      return { line: buffer.slice(0, i), next: buffer[i + 1] === '\n' ? i + 2 : i + 1 };
    }
  }
  return null;
}

async function consumeEventStream(response, signal) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('SSE の応答本文を読めません。');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let dataLines = [];
  let dataSize = 0;
  let eventName = '';
  let discarding = false;

  const dispatch = () => {
    if (!dataLines.length) { eventName = ''; return; }
    const name = eventName || 'message';
    const payload = dataLines.join('\n');
    dataLines = [];
    dataSize = 0;
    eventName = '';
    // 旧 EventSource の onmessage と同じく、既定の message だけを配る。
    if (name !== 'message') return;
    let event;
    try { event = JSON.parse(payload); } catch { return; }
    for (const fn of [...listeners]) {
      try { fn(event); } catch (error) {
        // 1つの購読者の失敗で流れは止めないが、UI の不具合を隠さず報告する。
        if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
        else setTimeout(() => { throw error; });
      }
    }
  };

  const processLine = line => {
    if (discarding) {
      if (line === '') discarding = false;
      return;
    }
    if (line === '') { dispatch(); return; }
    if (line.startsWith(':')) return;
    const at = line.indexOf(':');
    const field = at < 0 ? line : line.slice(0, at);
    let value = at < 0 ? '' : line.slice(at + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      dataSize += value.length + 1;
      if (dataSize > MAX_SSE_BUFFER) {
        dataLines = [];
        dataSize = 0;
        eventName = '';
        discarding = true;
        return;
      }
      dataLines.push(value);
    } else if (field === 'event') eventName = value;
    // legacyhost は Last-Event-ID による再送を持たないため、id は保持も送信もしない。
    else if (field === 'retry') {
      // 空文字や符号付きの値は仕様どおり無視する（Number('') は 0 になってしまう）。
      if (/^\d+$/.test(value)) {
        const ms = Number(value);
        if (Number.isFinite(ms)) {
          retryBase = Math.min(Math.max(ms, MIN_RETRY_MS), MAX_RETRY_MS);
          retryDelay = retryBase;
        }
      }
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (signal.aborted) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const found = nextLine(buffer);
        if (!found) break;
        buffer = buffer.slice(found.next);
        processLine(found.line);
      }
      if (buffer.length > MAX_SSE_BUFFER) {
        // 壊れた・終わらない行でメモリを使い続けない。次の空行までイベントを捨てる。
        buffer = '';
        dataLines = [];
        dataSize = 0;
        eventName = '';
        discarding = true;
      }
    }
    if (signal.aborted) return;
    buffer += decoder.decode();
    if (buffer) processLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

async function runEventStream(controller) {
  let reconnect = true;
  try {
    const eventsUrl = managementUrl('/api/events').href;
    const res = await fetch(eventsUrl, {
      headers: locationHeaders(eventsUrl),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    });
    if (controller.signal.aborted || streamController !== controller) {
      reconnect = false;
      return;
    }
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* body already gone */ }
      if (AUTH_STATUS.has(res.status)) {
        authLost = true;
        reconnect = false;
        clearStoredToken();
        notifyAuthLost();
      }
      return;
    }
    retryDelay = retryBase;
    await consumeEventStream(res, controller.signal);
  } catch {
    if (controller.signal.aborted || stopped) reconnect = false;
  } finally {
    if (streamController === controller) streamController = null;
    if (reconnect && !stopped && !authLost && !controller.signal.aborted) scheduleReconnect();
  }
}

function startEventStream() {
  if (streamController || stopped || authLost) return;
  const controller = new AbortController();
  streamController = controller;
  void runEventStream(controller);
}

function stopEvents() {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = 0; }
  const controller = streamController;
  streamController = null;
  controller?.abort();
}

startEventStream();
if (typeof addEventListener === 'function') {
  // 実際に画面が破棄されるときだけ止める。beforeunload は取り消されうるので使わない。
  addEventListener('pagehide', stopEvents);
  addEventListener('pageshow', event => {
    if (!event?.persisted) return;
    stopped = false;
    startEventStream();
  });
}

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
