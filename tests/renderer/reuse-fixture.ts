import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BaseWindow, nativeImage, protocol } from "electron";
import { JobDeadline } from "../../packages/renderer/src/deadline.js";
import { parseRenderJob } from "../../packages/renderer/src/job.js";
import { STUDIO_RENDER_SCHEME } from "../../packages/renderer/src/protocol.js";
import { renderDeck } from "../../packages/renderer/src/render.js";
import { RenderWindowPool } from "../../packages/renderer/src/render-window.js";

const root = process.argv[2]!;
app.setPath("userData", root);
app.dock?.hide();
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: STUDIO_RENDER_SCHEME, privileges: { standard: true, secure: true } }]);
app.on("window-all-closed", () => {});

async function verify() {
  const pool = new RenderWindowPool();
  async function capture(name: string, timeout = 8000) {
    const outputDir = join(root, name);
    const deadline = new JobDeadline(timeout, "capture timeout");
    try {
      const job = parseRenderJob({schemaVersion: 1, inputHtml: join(root, name + ".html"), outputDir, screenshots: true, pdf: false});
      const result = await renderDeck(job, outputDir, deadline, pool);
      const png = await readFile(join(outputDir, result.screenshotFiles[0]!));
      const image = nativeImage.createFromBuffer(png);
      assert.deepEqual(image.getSize(), {width: 1280, height: 720});
      return image.crop({x: 10, y: 10, width: 1, height: 1}).toBitmap().subarray(0, 3);
    } finally {
      deadline.dispose();
    }
  }
  try {
    assert.deepEqual(await capture("first"), Buffer.from([0, 0, 255]));
    const [win] = BaseWindow.getAllWindows();
    assert.ok(win && !win.isVisible());
    assert.equal(win.contentView.children.length, 0);
    assert.deepEqual(await capture("second"), Buffer.from([255, 0, 0]));
    assert.deepEqual(BaseWindow.getAllWindows().map(w => w.id), [win.id]);
    await assert.rejects(capture("timeout", 1200), /capture timeout/);
    assert.ok(win.isDestroyed());
    assert.deepEqual(await capture("second"), Buffer.from([255, 0, 0]));
  } finally {
    pool.close();
  }
  assert.equal(BaseWindow.getAllWindows().length, 0);
}

app.whenReady().then(verify).then(() => app.exit(0), error => {
  console.error(error);
  app.exit(1);
});
