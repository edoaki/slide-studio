import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_TIMEOUT_MS,
  JobValidationError,
  MAX_TIMEOUT_MS,
  parseRenderJob,
} from "../../packages/renderer/src/job.js";

const inputHtml = join(tmpdir(), "render-job-input.html");
const outputDir = join(tmpdir(), "render-job-output");

function valid(extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, inputHtml, outputDir, ...extra };
}

test("accepts a minimal job and applies defaults", () => {
  const job = parseRenderJob(valid());
  assert.equal(job.schemaVersion, 1);
  assert.equal(job.inputHtml, inputHtml);
  assert.equal(job.outputDir, outputDir);
  assert.equal(job.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(job.screenshots, true);
});

test("accepts explicit timeout and screenshots false", () => {
  const job = parseRenderJob(valid({ timeoutMs: 1, screenshots: false }));
  assert.equal(job.timeoutMs, 1);
  assert.equal(job.screenshots, false);
});

test("rejects non-objects and wrong schema versions", () => {
  for (const value of [null, [], "job", 1]) {
    assert.throws(() => parseRenderJob(value), JobValidationError);
  }
  assert.throws(() => parseRenderJob(valid({ schemaVersion: 2 })), /schemaVersion/);
  assert.throws(() => parseRenderJob(valid({ schemaVersion: "1" })), /schemaVersion/);
});

test("rejects missing, relative, empty, and NUL paths", () => {
  for (const field of ["inputHtml", "outputDir"] as const) {
    for (const value of [undefined, "", "relative.html", "\0bad"]) {
      assert.throws(() => parseRenderJob(valid({ [field]: value })), JobValidationError);
    }
  }
  assert.throws(
    () => parseRenderJob(valid({ outputDir: inputHtml })),
    /must differ/,
  );
});

test("rejects non-finite, non-positive, and unbounded timeouts", () => {
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_TIMEOUT_MS + 1, "1000"]) {
    assert.throws(() => parseRenderJob(valid({ timeoutMs: value })), /timeoutMs/);
  }
  assert.equal(parseRenderJob(valid({ timeoutMs: MAX_TIMEOUT_MS })).timeoutMs, MAX_TIMEOUT_MS);
});

test("rejects non-boolean screenshots", () => {
  for (const value of [null, 0, 1, "true"]) {
    assert.throws(() => parseRenderJob(valid({ screenshots: value })), /screenshots/);
  }
});
