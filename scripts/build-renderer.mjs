import { cp, copyFile, mkdir, rm, stat, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

const copies = [
  {
    source: resolve(root, "packages/renderer/assets"),
    target: resolve(dist, "packages/renderer/assets"),
    required: true,
    label: "renderer assets",
  },
  {
    source: resolve(root, "packages/core/assets"),
    target: resolve(dist, "packages/core/assets"),
    required: true,
    label: "core assets",
  },
  {
    source: resolve(root, "packages/web"),
    target: resolve(dist, "packages/web"),
    required: false,
    label: "web assets",
  },
];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyAssets(entry) {
  if (!(await exists(entry.source))) {
    if (entry.required) {
      throw new Error(`missing ${entry.label}: ${entry.source}`);
    }
    process.stderr.write(
      `build-renderer: ${entry.label} are not present at ${entry.source}; skipped\n`,
    );
    return;
  }
  await rm(entry.target, { recursive: true, force: true });
  await mkdir(dirname(entry.target), { recursive: true });
  await cp(entry.source, entry.target, { recursive: true });
}

if (process.argv.includes("--clean")) {
  await rm(dist, { recursive: true, force: true });
}

for (const entry of copies) {
  await copyAssets(entry);
}

// Core reads the same exported message constants as the UI. Generate this
// packaged copy from the single source, including for unpacked ASAR assets.
const stringsModule = resolve(root, "packages/web/strings.js");
if (await exists(stringsModule)) {
  await copyFile(stringsModule, resolve(dist, "packages/core/assets/strings.js"));
}

// The content agent must execute before authored slide scripts. Keep the
// preserved UI as ES modules and bundle only this first-head bootstrap.
const frameAgent = resolve(root, "packages/web/bridge/frame-agent.js");
if (!process.argv.includes("--clean") && await exists(frameAgent)) {
  await build({
    entryPoints: [frameAgent],
    outfile: resolve(dist, "packages/web/bridge/frame-agent.classic.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome156",
    sourcemap: false,
    legalComments: "inline",
  });
}

// A portable workspace carries compiled JS and assets, never this repository
// or Python. Dependencies/native tools are installed explicitly with --setup.
if (!process.argv.includes('--clean')) {
  const portable = resolve(dist, 'packages/core/assets/portable');
  const compiler = resolve(portable, 'compiler');
  for (const name of ['core', 'renderer']) {
    await mkdir(resolve(compiler, `packages/${name}`), {recursive:true});
    await cp(resolve(dist, `packages/${name}/src`), resolve(compiler, `packages/${name}/src`), {recursive:true,filter:p=>!p.endsWith('.map')});
    await cp(resolve(root, `packages/${name}/assets`), resolve(compiler, `packages/${name}/assets`), {recursive:true});
  }
  await copyFile(stringsModule, resolve(compiler,'packages/core/assets/strings.js'));
  for (const path of ['apps/portable/main.js','apps/server/legacy-output.js']) {
    await mkdir(dirname(resolve(compiler,path)),{recursive:true});await copyFile(resolve(dist,path),resolve(compiler,path));
  }
  await mkdir(resolve(compiler,'scripts'),{recursive:true});
  await copyFile(resolve(root,'scripts/setup-pandoc.mjs'),resolve(compiler,'scripts/setup-pandoc.mjs'));
  await mkdir(resolve(compiler,'resources/pandoc'),{recursive:true});
  await copyFile(resolve(root,'resources/pandoc/manifest.json'),resolve(compiler,'resources/pandoc/manifest.json'));
  await copyFile(resolve(root,'resources/pandoc/COPYING.md'),resolve(compiler,'resources/pandoc/COPYING.md'));
  const pkg=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
  const dependencies={...pkg.dependencies,electron:pkg.devDependencies.electron,'@electron-internal/extract-zip':pkg.devDependencies['@electron-internal/extract-zip']};
  await writeFile(resolve(compiler,'package.json'),JSON.stringify({name:'slide-studio-portable',version:pkg.version,private:true,type:'module',engines:pkg.engines,dependencies},null,2)+'\n');
  await copyFile(resolve(root,'LICENSE'),resolve(compiler,'LICENSE'));
  await copyFile(resolve(root,'NOTICE.md'),resolve(compiler,'NOTICE.md'));
  await copyFile(resolve(root,'scripts/portable-launcher.mjs'),resolve(portable,'build.mjs'));
}
