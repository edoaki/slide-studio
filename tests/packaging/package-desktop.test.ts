import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

type PlatformName = "darwin" | "win32";
type Architecture = "arm64" | "x64";

interface PlatformDescriptor {
  platform: PlatformName;
  arch: Architecture;
  target: string;
  manifestKey: string;
  binaryName: string;
}

interface ParsedArguments {
  help: boolean;
  stageOnly: boolean;
  platform?: PlatformName;
  arch?: Architecture;
  target?: string;
}

interface StageManifest {
  schemaVersion: number;
  owner: string;
  platform: PlatformName;
  arch: Architecture;
  target: string;
  pandocVersion: string;
  source: string;
  archiveUrl: string;
  archiveSha256: string;
  binary: string;
  binarySha256: string;
}

interface PackagingModule {
  MAX_DOWNLOAD_BYTES: number;
  parseArgs(argv: string[]): ParsedArguments;
  resolvePlatform(platform: string, arch: string): PlatformDescriptor;
  loadManifest(options?: { root?: string }): Promise<{
    version: string;
    source: string;
    platforms: Record<string, { url: string; sha256: string }>;
  }>;
  sha256File(filePath: string): Promise<string>;
  assertDigest(filePath: string, expected: string): Promise<string>;
  assertTrustedReleaseUrl(value: string, options?: { version?: string }): string;
  obtainArchive(options: {
    cacheDir: string;
    url: string;
    sha256: string;
    fetchImpl?: typeof fetch;
    maxBytes?: number;
    timeoutMs?: number;
    log?: (message: string) => void;
  }): Promise<{ path: string; sha256: string; cached: boolean }>;
  findPandocBinary(
    extractionRoot: string,
    descriptor: PlatformDescriptor,
    expectedFolder?: string,
  ): Promise<string>;
  stageExtractedTree(options: {
    root: string;
    descriptor: PlatformDescriptor;
    manifest: { version: string; source: string };
    entry: { url: string; sha256: string };
    extractionRoot: string;
    expectedFolder?: string;
    archiveSha256: string;
    log?: (message: string) => void;
  }): Promise<{
    targetDir: string;
    binaryPath: string;
    binarySha256: string;
    archiveSha256: string;
    manifest: StageManifest;
  }>;
  generateChecksums(options: {
    root?: string;
    releaseDir: string;
    log?: (message: string) => void;
  }): Promise<{ path: string; artifacts: string[] }>;
  main(argv: string[], options?: { log?: (message: string) => void }): Promise<number>;
}

function findRepositoryRoot(start: string): string {
  let directory = start;
  for (let depth = 0; depth < 12; depth++) {
    if (
      existsSync(join(directory, "package.json")) &&
      existsSync(join(directory, "scripts", "package-desktop.mjs"))
    ) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`cannot locate the repository root from ${start}`);
}

const repositoryRoot = findRepositoryRoot(dirname(fileURLToPath(import.meta.url)));
const packaging = (await import(
  pathToFileURL(join(repositoryRoot, "scripts", "package-desktop.mjs")).href
)) as PackagingModule;

const releaseUrl =
  "https://github.com/jgm/pandoc/releases/download/3.9/pandoc-3.9-arm64-macOS.zip";
const archiveSha = "7d56ac6fe6fad0a7407bcd776aa142f61ca41838f286165f79d0584fa57b24d1";

async function scratch(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "packaging-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

test("parses explicit targets and rejects unsupported combinations", () => {
  assert.deepEqual(packaging.parseArgs(["--mac", "--arch", "arm64"]), {
    help: false,
    platform: "darwin",
    arch: "arm64",
    target: "mac-arm64",
    stageOnly: false,
  });
  assert.deepEqual(packaging.parseArgs(["--mac", "--arch=x64", "--stage-only"]), {
    help: false,
    platform: "darwin",
    arch: "x64",
    target: "mac-x64",
    stageOnly: true,
  });
  assert.deepEqual(packaging.parseArgs(["--win"]), {
    help: false,
    platform: "win32",
    arch: "x64",
    target: "win-x64",
    stageOnly: false,
  });
  assert.equal(packaging.parseArgs(["--help"]).help, true);
  assert.equal(packaging.resolvePlatform("mac", "arm64").manifestKey, "darwin-arm64");
  assert.equal(packaging.resolvePlatform("win", "x64").binaryName, "pandoc.exe");

  assert.throws(() => packaging.parseArgs(["--win", "--arch", "arm64"]), /unsupported/i);
  assert.throws(() => packaging.parseArgs(["--mac", "--arch", "ia32"]), /unsupported/i);
  assert.throws(() => packaging.parseArgs(["--linux"]), /unknown argument/i);
  assert.throws(() => packaging.parseArgs(["--mac", "--win"]), /exactly one/i);
  assert.throws(() => packaging.parseArgs(["--mac", "--arch"]), /requires/i);
  assert.throws(() => packaging.resolvePlatform("linux", "x64"), /unsupported platform/i);
  assert.throws(() => packaging.resolvePlatform("win32", "arm64"), /unsupported target/i);
});

test("accepts only the fixed GitHub release URL and HTTPS redirect targets", () => {
  assert.equal(packaging.assertTrustedReleaseUrl(releaseUrl), releaseUrl);
  assert.throws(
    () => packaging.assertTrustedReleaseUrl(releaseUrl.replace("https:", "http:")),
    /HTTPS/i,
  );
  assert.throws(
    () => packaging.assertTrustedReleaseUrl(releaseUrl.replace("github.com", "example.com")),
    /untrusted/i,
  );
  assert.throws(
    () => packaging.assertTrustedReleaseUrl(releaseUrl.replace("/3.9/", "/3.10/")),
    /must be under/i,
  );
  assert.throws(
    () => packaging.assertTrustedReleaseUrl(`${releaseUrl}?download=1`),
    /query/i,
  );
});

test("hashes local files and rejects a mismatched digest", async (t) => {
  const root = await scratch(t);
  const file = join(root, "archive.zip");
  const bytes = Buffer.from("not a real archive, just fixture bytes");
  await writeFile(file, bytes);
  const expected = digest(bytes);

  assert.equal(await packaging.sha256File(file), expected);
  assert.equal(await packaging.assertDigest(file, expected.toUpperCase()), expected);
  await assert.rejects(
    packaging.assertDigest(file, "0".repeat(64)),
    /SHA-256 mismatch/i,
  );
});

test("downloads once, verifies SHA-256, and reuses the shared cache", async (t) => {
  const root = await scratch(t);
  const cacheDir = join(root, "cache", "shared");
  const payload = Buffer.from("cached pandoc archive fixture");
  const expected = digest(payload);
  let calls = 0;

  const first = await packaging.obtainArchive({
    cacheDir,
    url: releaseUrl,
    sha256: expected,
    fetchImpl: async (_input, init) => {
      calls++;
      assert.equal(init?.redirect, "manual");
      return new Response(payload.toString(), { status: 200 });
    },
    log: () => {},
  });
  assert.equal(first.cached, false);
  assert.equal(first.sha256, expected);
  assert.deepEqual(await readFile(first.path), payload);

  const second = await packaging.obtainArchive({
    cacheDir,
    url: releaseUrl,
    sha256: expected,
    fetchImpl: async () => {
      throw new Error("network must not be used for a valid cache entry");
    },
    log: () => {},
  });
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(cacheDir), ["pandoc-3.9-arm64-macOS.zip"]);
});

test("removes failed downloads and never keeps a digest mismatch", async (t) => {
  const root = await scratch(t);
  const cacheDir = join(root, "cache", "shared");
  const payload = Buffer.from("wrong bytes");

  await assert.rejects(
    packaging.obtainArchive({
      cacheDir,
      url: releaseUrl,
      sha256: archiveSha,
      fetchImpl: async () => new Response(payload.toString(), { status: 200 }),
      log: () => {},
    }),
    /SHA-256 mismatch/i,
  );
  assert.deepEqual(await readdir(cacheDir), []);

  await assert.rejects(
    packaging.obtainArchive({
      cacheDir,
      url: releaseUrl,
      sha256: digest(payload),
      maxBytes: payload.length - 1,
      fetchImpl: async () => new Response(payload.toString(), { status: 200 }),
      log: () => {},
    }),
    /exceeds/i,
  );
  assert.deepEqual(await readdir(cacheDir), []);
});

test("follows only HTTPS redirects for downloads", async (t) => {
  const root = await scratch(t);
  const cacheDir = join(root, "cache", "shared");
  const payload = Buffer.from("redirected archive fixture");
  const expected = digest(payload);

  const result = await packaging.obtainArchive({
    cacheDir,
    url: releaseUrl,
    sha256: expected,
    fetchImpl: async (input) => {
      if (String(input).startsWith("https://github.com/")) {
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://release-assets.githubusercontent.com/asset.zip",
          },
        });
      }
      return new Response(payload.toString(), { status: 200 });
    },
    log: () => {},
  });
  assert.equal(result.cached, false);
  assert.deepEqual(await readFile(result.path), payload);

  await assert.rejects(
    packaging.obtainArchive({
      cacheDir: join(root, "other-cache"),
      url: releaseUrl,
      sha256: expected,
      fetchImpl: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://release-assets.githubusercontent.com/asset.zip" },
        }),
      log: () => {},
    }),
    /redirect must use HTTPS/i,
  );
});

test("finds the native binary under the exact archive folder", async (t) => {
  const root = await scratch(t);
  const folder = join(root, "pandoc-3.9-arm64-macOS");
  await mkdir(join(folder, "bin"), { recursive: true });
  await writeFile(join(folder, "bin", "pandoc"), "mac binary");
  await writeFile(join(folder, "bin", "pandoc.exe"), "foreign binary");

  const descriptor = packaging.resolvePlatform("mac", "arm64");
  const found = await packaging.findPandocBinary(
    root,
    descriptor,
    "pandoc-3.9-arm64-macOS",
  );
  assert.equal(found, join(folder, "bin", "pandoc"));
});

test("uses a bounded walk for an unexpected archive layout", async (t) => {
  const root = await scratch(t);
  const folder = join(root, "unexpected", "layout", "deep");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "pandoc.exe"), "windows binary");

  const descriptor = packaging.resolvePlatform("win", "x64");
  const found = await packaging.findPandocBinary(root, descriptor, "wrong-folder");
  assert.equal(found, join(folder, "pandoc.exe"));
});

test("does not follow a symlink to a foreign binary", async (t) => {
  const root = await scratch(t);
  const real = join(root, "real-pandoc");
  const folder = join(root, "pandoc-3.9-arm64-macOS", "bin");
  await mkdir(folder, { recursive: true });
  await writeFile(real, "outside binary");
  try {
    await symlink(real, join(folder, "pandoc"));
  } catch {
    t.skip("symlinks are unavailable");
    return;
  }

  const descriptor = packaging.resolvePlatform("mac", "arm64");
  await assert.rejects(
    packaging.findPandocBinary(root, descriptor, "pandoc-3.9-arm64-macOS"),
    /symlink|could not find/i,
  );
});

test("stages the binary, licence, source notice and recorded hashes", async (t) => {
  const root = await scratch(t);
  const resources = join(root, "resources", "pandoc");
  await mkdir(resources, { recursive: true });
  await writeFile(join(resources, "COPYING.md"), "GPL fixture");

  const extractionRoot = join(root, "extract");
  const expectedFolder = "pandoc-3.9-arm64-macOS";
  await mkdir(join(extractionRoot, expectedFolder, "bin"), { recursive: true });
  const binary = Buffer.from("native pandoc fixture");
  await writeFile(join(extractionRoot, expectedFolder, "bin", "pandoc"), binary);

  const descriptor = packaging.resolvePlatform("mac", "arm64");
  const result = await packaging.stageExtractedTree({
    root,
    descriptor,
    manifest: {
      version: "3.9",
      source: "https://github.com/jgm/pandoc/releases/tag/3.9",
    },
    entry: { url: releaseUrl, sha256: archiveSha },
    extractionRoot,
    expectedFolder,
    archiveSha256: archiveSha,
    log: () => {},
  });

  const target = join(root, "resources", "pandoc", "targets", "mac-arm64");
  assert.equal(result.targetDir, target);
  assert.deepEqual(await readFile(join(target, "bin", "pandoc")), binary);
  assert.equal(await readFile(join(target, "COPYING.md"), "utf8"), "GPL fixture");

  const source = await readFile(join(target, "SOURCE.txt"), "utf8");
  assert.match(source, /github\.com\/jgm\/pandoc\/releases\/tag\/3\.9/);
  assert.match(source, /github\.com\/jgm\/pandoc\/releases\/download\/3\.9\//);

  const recorded = JSON.parse(
    await readFile(join(target, "stage-manifest.json"), "utf8"),
  ) as StageManifest;
  assert.equal(recorded.owner, "slide-studio-package-desktop");
  assert.equal(recorded.platform, "darwin");
  assert.equal(recorded.arch, "arm64");
  assert.equal(recorded.pandocVersion, "3.9");
  assert.equal(recorded.archiveSha256, archiveSha);
  assert.equal(recorded.binarySha256, digest(binary));

  if (process.platform !== "win32") {
    const info = await lstat(join(target, "bin", "pandoc"));
    assert.ok((info.mode & 0o111) !== 0, "staged macOS binary must be executable");
  }
});

test("replaces only a previously owned stage", async (t) => {
  const root = await scratch(t);
  const resources = join(root, "resources", "pandoc");
  await mkdir(resources, { recursive: true });
  await writeFile(join(resources, "COPYING.md"), "GPL fixture");

  const extractionRoot = join(root, "extract");
  const expectedFolder = "pandoc-3.9-arm64-macOS";
  await mkdir(join(extractionRoot, expectedFolder, "bin"), { recursive: true });
  await writeFile(join(extractionRoot, expectedFolder, "bin", "pandoc"), "first");

  const descriptor = packaging.resolvePlatform("mac", "arm64");
  const options = {
    root,
    descriptor,
    manifest: {
      version: "3.9",
      source: "https://github.com/jgm/pandoc/releases/tag/3.9",
    },
    entry: { url: releaseUrl, sha256: archiveSha },
    extractionRoot,
    expectedFolder,
    archiveSha256: archiveSha,
    log: () => {},
  };
  await packaging.stageExtractedTree(options);
  await writeFile(join(extractionRoot, expectedFolder, "bin", "pandoc"), "second");
  await packaging.stageExtractedTree(options);
  assert.equal(
    await readFile(
      join(root, "resources", "pandoc", "targets", "mac-arm64", "bin", "pandoc"),
      "utf8",
    ),
    "second",
  );

  const foreignRoot = await scratch(t);
  const target = join(foreignRoot, "resources", "pandoc", "targets", "mac-arm64");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "sentinel.txt"), "keep");
  await writeFile(join(foreignRoot, "resources", "pandoc", "COPYING.md"), "GPL fixture");
  await assert.rejects(
    packaging.stageExtractedTree({
      ...options,
      root: foreignRoot,
      extractionRoot,
    }),
    /refusing to replace/i,
  );
  assert.equal(await readFile(join(target, "sentinel.txt"), "utf8"), "keep");
});

test("writes SHA256SUMS for top-level package artifacts only", async (t) => {
  const root = await scratch(t);
  const release = join(root, "release");
  await mkdir(release, { recursive: true });
  await mkdir(join(release, "mac-arm64-unpacked.dmg"));
  await writeFile(join(release, "Slide-Studio.dmg"), "dmg fixture");
  await writeFile(join(release, "Slide-Studio.exe"), "exe fixture");
  await writeFile(join(release, "Slide-Studio.dmg.blockmap"), "blockmap fixture");
  await writeFile(join(release, "builder.yml"), "ignored");
  await writeFile(join(release, "latest.yml"), "ignored");

  const result = await packaging.generateChecksums({
    releaseDir: release,
    log: () => {},
  });
  const text = await readFile(join(release, "SHA256SUMS"), "utf8");
  const lines = text.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(text, /Slide-Studio\.dmg$/m);
  assert.match(text, /Slide-Studio\.exe$/m);
  assert.match(text, /Slide-Studio\.dmg\.blockmap$/m);
  assert.doesNotMatch(text, /builder\.yml|latest\.yml|unpacked/);
  assert.equal(result.artifacts.length, 3);
  assert.ok(text.startsWith(`${digest("dmg fixture")}  Slide-Studio.dmg`));
});
