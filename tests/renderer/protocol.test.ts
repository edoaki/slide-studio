import assert from "node:assert/strict";
import test from "node:test";
import {
  ENTRY_URL,
  RENDER_CSP,
  classifyRenderUrl,
  isAllowedRenderUrl,
} from "../../packages/renderer/src/protocol.js";

test("accepts only the exact in-memory entry URL", () => {
  assert.equal(classifyRenderUrl(ENTRY_URL), "entry");
  assert.equal(classifyRenderUrl("studio-render://bundle/index.html?x=1"), "blocked");
  assert.equal(classifyRenderUrl("studio-render://bundle/index.html#x"), "blocked");
  assert.equal(classifyRenderUrl("studio-render://bundle/"), "blocked");
  assert.equal(classifyRenderUrl("studio-render://bundle/other.html"), "blocked");
  assert.equal(classifyRenderUrl("studio-render://other/index.html"), "blocked");
  assert.equal(classifyRenderUrl("studio-render://bundle/index.html/"), "blocked");
  assert.equal(classifyRenderUrl("studio-render://u:p@bundle/index.html"), "blocked");
  assert.equal(classifyRenderUrl("studio-render://bundle:99/index.html"), "blocked");
  assert.equal(classifyRenderUrl("STUDIO-RENDER://bundle/index.html"), "blocked");
});

test("rejects network, file, and script URLs", () => {
  for (const url of [
    "http://example.com/",
    "https://example.com/a.js",
    "file:///tmp/index.html",
    "javascript:alert(1)",
    "chrome://settings",
  ]) {
    assert.equal(classifyRenderUrl(url), "blocked", url);
    assert.equal(isAllowedRenderUrl(url), false, url);
  }
});

test("allows embedded data, blob, and about iframe assets", () => {
  for (const url of [
    "data:text/javascript;base64,AAAA",
    "data:image/png;base64,AAAA",
    "blob:studio-render://bundle/1234",
    "blob:null/1234",
    "about:blank",
    "about:srcdoc",
  ]) {
    assert.equal(classifyRenderUrl(url), "embedded", url);
    assert.equal(isAllowedRenderUrl(url), true, url);
  }
  assert.equal(classifyRenderUrl("about:config"), "blocked");
});

test("rejects malformed and padded URLs", () => {
  for (const url of ["", "not a url", " studio-render://bundle/index.html"]) {
    assert.equal(classifyRenderUrl(url), "blocked", JSON.stringify(url));
  }
});

test("CSP supports bundled scripts/styles/data without eval or bypass", () => {
  assert.match(RENDER_CSP, /script-src[^;]*'unsafe-inline'/);
  assert.match(RENDER_CSP, /script-src[^;]*data:/);
  assert.match(RENDER_CSP, /style-src[^;]*'unsafe-inline'/);
  assert.match(RENDER_CSP, /frame-src[^;]*about:/);
  assert.match(RENDER_CSP, /font-src[^;]*data:/);
  assert.doesNotMatch(RENDER_CSP, /unsafe-eval/);
  assert.doesNotMatch(RENDER_CSP, /bypass/i);
});
