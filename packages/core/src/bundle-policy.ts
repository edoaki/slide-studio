/**
 * Bundles use inline scripts/styles, data: module imports, data: fonts/images,
 * and srcdoc iframes. No unsafe-eval and no CSP bypass are granted.
 */
export const BUNDLE_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "script-src 'self' 'unsafe-inline' data:",
  "style-src 'self' 'unsafe-inline' data:",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "frame-src data: blob: about:",
  "connect-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
].join("; ");
