// コピーできないときは全文を残し、手動で写せるようにする。
import { toast } from './api.js';
import { S } from './strings.js';

export async function copyWithFallback(text, banner) {
  try {
    await navigator.clipboard.writeText(text);
    toast(S.copied);
    return true;
  } catch {
    let fallback = banner.querySelector('.copy-fallback');
    if (!fallback) {
      fallback = document.createElement('div');
      fallback.className = 'copy-fallback memo-field';
      fallback.innerHTML = `<p role="alert">${S.copyFailed}</p><textarea readonly rows="6" aria-label="${S.copyManual}"></textarea>`;
      banner.querySelector('.banner').append(fallback);
    }
    const input = fallback.querySelector('textarea');
    input.value = text; input.focus(); input.select();
    return false;
  }
}
