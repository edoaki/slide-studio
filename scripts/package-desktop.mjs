#!/usr/bin/env node
/**
 * Package Slide Studio for macOS (DMG) or Windows (NSIS).
 *
 * This script owns native Pandoc staging and never edits the frozen
 * electron-builder.json config. It deliberately builds only an explicitly
 * requested target and never signs with a developer identity or publishes.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync, realpathSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_RELATIVE = join("resources", "pandoc", "manifest.json");
const CACHE_RELATIVE = join("resources", "pandoc", "cache", "shared");
const TARGETS_RELATIVE = join("resources", "pandoc", "targets");
const LICENSE_RELATIVE = join("resources", "pandoc", "COPYING.md");

export const MAX_DOWNLOAD_BYTES = 120 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 120_000;
export const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
export const STAGE_MANIFEST = "stage-manifest.json";
export const STAGE_OWNER = "slide-studio-package-desktop";

const MAX_REDIRECTS = 5;
const MAX_WALK_DEPTH = 6;
const MAX_WALK_ENTRIES = 20_000;
const MAX_CAPTURE_BYTES = 512 * 1024;

const PLATFORM_DESCRIPTORS = Object.freeze({
  "darwin-arm64": Object.freeze({
    platform: "darwin",
    arch: "arm64",
    target: "mac-arm64",
    manifestKey: "darwin-arm64",
    binaryName: "pandoc",
  }),
  "darwin-x64": Object.freeze({
    platform: "darwin",
    arch: "x64",
    target: "mac-x64",
    manifestKey: "darwin-x64",
    binaryName: "pandoc",
  }),
  "win32-x64": Object.freeze({
    platform: "win32",
    arch: "x64",
    target: "win-x64",
    manifestKey: "win32-x64",
    binaryName: "pandoc.exe",
  }),
});

export class PackagingError extends Error {
  constructor(message) {
    super(message);
    this.name = "PackagingError";
  }
}

export class BuildError extends PackagingError {
  constructor(message, { exitCode = null, signal = null, output = "" } = {}) {
    super(message);
    this.name = "BuildError";
    this.exitCode = exitCode;
    this.signal = signal;
    this.output = output;
  }
}

function silentLog() {}

function defaultLog(message) {
  process.stderr.write(`package-desktop: ${message}\n`);
}

function randomSuffix() {
  return `${process.pid}-${randomBytes(6).toString("hex")}`;
}

function normalizePlatform(value) {
  if (value === "darwin" || value === "mac") return "darwin";
  if (value === "win32" || value === "win") return "win32";
  throw new PackagingError(`unsupported platform: ${String(value)}`);
}

/**
 * Reject any platform/architecture combination we do not ship.
 * Accepts both `darwin`/`mac` and `win32`/`win` aliases.
 */
export function resolvePlatform(platform, arch) {
  const normalized = normalizePlatform(platform);
  const key = `${normalized}-${String(arch)}`;
  const descriptor = PLATFORM_DESCRIPTORS[key];
  if (!descriptor) {
    throw new PackagingError(`unsupported target: ${normalized}/${String(arch)}`);
  }
  return descriptor;
}

function descriptorForArch(platform, arch) {
  if (arch !== undefined) return resolvePlatform(platform, arch);
  if (platform === "win32") return resolvePlatform(platform, "x64");
  if (process.arch === "arm64" || process.arch === "x64") {
    return resolvePlatform(platform, process.arch);
  }
  throw new PackagingError(
    `cannot infer macOS architecture from process.arch=${process.arch}; pass --arch arm64 or --arch x64`,
  );
}

export const HELP_TEXT = `Usage:
  node scripts/package-desktop.mjs --mac [--arch arm64|x64] [--stage-only]
  node scripts/package-desktop.mjs --win [--arch x64] [--stage-only]
  node scripts/package-desktop.mjs --help

Options:
  --mac        Build the macOS DMG for the current arch (arm64 or x64).
  --win        Build the Windows NSIS x64 installer.
  --arch <a>   Explicit target architecture. Windows supports x64 only.
  --stage-only Verify/download and stage native Pandoc, but skip electron-builder.
  --help       Show this help.

The script never signs with a developer identity, never publishes, and only
builds the one explicitly requested target.
`;

/**
 * Parse CLI arguments. The default macOS architecture comes from process.arch.
 */
export function parseArgs(argv) {
  let platform;
  let arch;
  let stageOnly = false;
  let help = false;

  function select(nextPlatform) {
    if (platform !== undefined) {
      throw new PackagingError("choose exactly one of --mac or --win");
    }
    platform = nextPlatform;
  }

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--mac") {
      select("darwin");
      continue;
    }
    if (argument === "--win") {
      select("win32");
      continue;
    }
    if (argument === "--stage-only") {
      stageOnly = true;
      continue;
    }
    if (argument === "--arch") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) {
        throw new PackagingError("--arch requires arm64 or x64");
      }
      if (arch !== undefined) throw new PackagingError("--arch may be provided only once");
      arch = value;
      continue;
    }
    if (argument.startsWith("--arch=")) {
      if (arch !== undefined) throw new PackagingError("--arch may be provided only once");
      arch = argument.slice("--arch=".length);
      continue;
    }
    throw new PackagingError(`unknown argument: ${argument}`);
  }

  if (help) return { help: true, stageOnly };

  if (platform === undefined) {
    throw new PackagingError("choose one target: --mac or --win");
  }
  const descriptor = descriptorForArch(platform, arch);
  return {
    help: false,
    platform: descriptor.platform,
    arch: descriptor.arch,
    target: descriptor.target,
    stageOnly,
  };
}

function normalizeSha256(value, label = "sha256") {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new PackagingError(`${label} must be a 64-character hexadecimal SHA-256`);
  }
  return value.toLowerCase();
}

/**
 * Validate the fixed GitHub release URL we are willing to download from.
 */
export function assertTrustedReleaseUrl(value, { version = "3.9" } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PackagingError(`invalid Pandoc archive URL: ${String(value)}`);
  }
  if (url.protocol !== "https:") {
    throw new PackagingError("Pandoc archive URL must use HTTPS");
  }
  if (url.username || url.password || url.port) {
    throw new PackagingError("Pandoc archive URL must not contain credentials or a port");
  }
  if (url.hostname !== "github.com") {
    throw new PackagingError(`untrusted Pandoc archive host: ${url.hostname}`);
  }
  const prefix = `/jgm/pandoc/releases/download/${version}/`;
  if (!url.pathname.startsWith(prefix)) {
    throw new PackagingError(`Pandoc archive URL must be under ${prefix}`);
  }
  const file = url.pathname.slice(prefix.length);
  if (!file || file.includes("/") || !/^[A-Za-z0-9._-]+\.zip$/.test(file)) {
    throw new PackagingError("Pandoc archive URL must name a single zip file");
  }
  if (url.search || url.hash) {
    throw new PackagingError("Pandoc archive URL must not contain a query or fragment");
  }
  return url.href;
}

function assertHttpsUrl(value, label = "URL") {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PackagingError(`${label} is not a valid URL: ${String(value)}`);
  }
  if (url.protocol !== "https:") {
    throw new PackagingError(`${label} must use HTTPS`);
  }
  if (url.username || url.password) {
    throw new PackagingError(`${label} must not contain credentials`);
  }
  return url;
}

function assertTrustedSourceUrl(value, version) {
  const url = assertHttpsUrl(value, "Pandoc source URL");
  if (url.hostname !== "github.com") {
    throw new PackagingError(`untrusted Pandoc source host: ${url.hostname}`);
  }
  const expected = `/jgm/pandoc/releases/tag/${version}`;
  if (url.pathname !== expected) {
    throw new PackagingError(`Pandoc source URL must be ${expected}`);
  }
  return url.href;
}

export async function loadManifest({ root = ROOT } = {}) {
  const manifestPath = join(root, MANIFEST_RELATIVE);
  let value;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new PackagingError(`cannot read ${manifestPath}: ${error.message}`);
  }
  if (typeof value?.version !== "string" || !/^[0-9]+(?:\.[0-9]+)+$/.test(value.version)) {
    throw new PackagingError("Pandoc manifest version is missing or invalid");
  }
  if (typeof value?.source !== "string") {
    throw new PackagingError("Pandoc manifest source is missing");
  }
  assertTrustedSourceUrl(value.source, value.version);
  if (value.platforms === null || typeof value.platforms !== "object") {
    throw new PackagingError("Pandoc manifest platforms are missing");
  }
  for (const [key, entry] of Object.entries(value.platforms)) {
    if (entry === null || typeof entry !== "object") {
      throw new PackagingError(`Pandoc manifest entry ${key} is invalid`);
    }
    assertTrustedReleaseUrl(entry.url, { version: value.version });
    normalizeSha256(entry.sha256, `${key} sha256`);
  }
  return value;
}

function pandocEntry(manifest, descriptor) {
  const entry = manifest.platforms?.[descriptor.manifestKey];
  if (entry === undefined) {
    throw new PackagingError(`Pandoc manifest has no ${descriptor.manifestKey} entry`);
  }
  return {
    url: assertTrustedReleaseUrl(entry.url, { version: manifest.version }),
    sha256: normalizeSha256(entry.sha256, `${descriptor.manifestKey} sha256`),
  };
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  try {
    for await (const chunk of stream) hash.update(chunk);
  } finally {
    stream.destroy();
  }
  return hash.digest("hex");
}

export async function assertDigest(filePath, expected) {
  const wanted = normalizeSha256(expected);
  const actual = await sha256File(filePath);
  if (actual !== wanted) {
    throw new PackagingError(
      `SHA-256 mismatch for ${basename(filePath)}: expected ${wanted}, got ${actual}`,
    );
  }
  return actual;
}

async function lstatOptional(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function* bodyChunks(body) {
  if (body === null || body === undefined) {
    throw new PackagingError("download response has no body");
  }
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock?.();
    }
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    yield* body;
    return;
  }
  throw new PackagingError("download response body is not readable");
}

async function downloadToFile({
  url,
  destination,
  fetchImpl,
  maxBytes,
  timeoutMs,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new PackagingError(`download timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();

  const handle = await open(destination, "wx", 0o600);
  let total = 0;
  try {
    let current = assertHttpsUrl(url, "Pandoc archive URL").href;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      let response;
      try {
        response = await fetchImpl(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": "slide-studio-packaging" },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new PackagingError(`download timed out after ${timeoutMs}ms`);
        }
        throw new PackagingError(`download failed: ${error.message}`);
      }

      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel?.();
        if (!location) throw new PackagingError("download redirect has no Location header");
        const next = new URL(location, current);
        if (next.protocol !== "https:") {
          throw new PackagingError("download redirect must use HTTPS");
        }
        if (next.username || next.password) {
          throw new PackagingError("download redirect must not contain credentials");
        }
        current = next.href;
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel?.();
        throw new PackagingError(`download failed with HTTP ${response.status}`);
      }

      try {
        for await (const chunk of bodyChunks(response.body)) {
          const bytes = Buffer.from(chunk);
          total += bytes.length;
          if (total > maxBytes) {
            throw new PackagingError(`download exceeds the ${maxBytes}-byte limit`);
          }
          await handle.write(bytes);
        }
      } catch (error) {
        if (controller.signal.aborted) {
          throw new PackagingError(`download timed out after ${timeoutMs}ms`);
        }
        throw error;
      }
      await handle.sync();
      return total;
    }
    throw new PackagingError(`download exceeded ${MAX_REDIRECTS} redirects`);
  } finally {
    clearTimeout(timer);
    await handle.close();
  }
}

function cacheFileName(url) {
  const pathname = new URL(url).pathname;
  const name = basename(pathname);
  if (!/^[A-Za-z0-9._-]+\.zip$/.test(name)) {
    throw new PackagingError(`Pandoc archive URL has an unsafe file name: ${name}`);
  }
  return name;
}

/**
 * Return a digest-verified cached archive, downloading atomically if needed.
 * Cache files are shared with same-host setup scripts.
 */
export async function obtainArchive({
  cacheDir,
  url,
  sha256,
  fetchImpl = globalThis.fetch,
  maxBytes = MAX_DOWNLOAD_BYTES,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  log = silentLog,
} = {}) {
  const expected = normalizeSha256(sha256);
  assertHttpsUrl(url, "Pandoc archive URL");
  if (typeof fetchImpl !== "function") throw new PackagingError("fetch is unavailable");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new PackagingError("maxBytes must be a positive integer");
  }

  await mkdir(cacheDir, { recursive: true });
  const name = cacheFileName(url);
  const cachedPath = join(cacheDir, name);
  const cachedInfo = await lstatOptional(cachedPath);
  if (cachedInfo !== undefined) {
    if (!cachedInfo.isFile() || cachedInfo.isSymbolicLink()) {
      throw new PackagingError(`cache entry is not a regular file: ${cachedPath}`);
    }
    const digest = await sha256File(cachedPath);
    if (digest === expected) {
      log(`using cached Pandoc archive ${name}`);
      return { path: cachedPath, sha256: digest, cached: true };
    }
    log(`discarding cached Pandoc archive with a mismatched digest: ${name}`);
    await rm(cachedPath, { force: true });
  }

  const temporary = join(cacheDir, `.${name}.${randomSuffix()}.tmp`);
  try {
    log(`downloading ${url}`);
    await downloadToFile({
      url,
      destination: temporary,
      fetchImpl,
      maxBytes,
      timeoutMs,
    });
    const digest = await sha256File(temporary);
    if (digest !== expected) {
      throw new PackagingError(
        `SHA-256 mismatch for ${name}: expected ${expected}, got ${digest}`,
      );
    }
    await rename(temporary, cachedPath);
    return { path: cachedPath, sha256: digest, cached: false };
  } finally {
    await rm(temporary, { force: true });
  }
}

async function extractArchive(archivePath, destination, extractImpl) {
  let extract = extractImpl;
  if (extract === undefined) {
    const module = await import("@electron-internal/extract-zip");
    extract = module.default ?? module.extract ?? module;
  }
  if (typeof extract !== "function") {
    throw new PackagingError("cannot load @electron-internal/extract-zip");
  }
  await extract(archivePath, { dir: resolve(destination) });
}

async function regularFile(root, filePath) {
  if (!inside(root, filePath)) return undefined;
  const parts = relative(root, filePath).split(sep).filter(Boolean);
  let current = root;
  let info;
  for (const part of parts) {
    current = join(current, part);
    info = await lstatOptional(current);
    if (info === undefined) return undefined;
    if (info.isSymbolicLink()) {
      throw new PackagingError(`refusing symlink while locating Pandoc: ${current}`);
    }
  }
  return info?.isFile() ? filePath : undefined;
}

function inside(root, candidate) {
  const base = resolve(root);
  const target = resolve(candidate);
  return target === base || target.startsWith(base + sep);
}

function archiveFolder(url) {
  try {
    const name = basename(new URL(url).pathname).replace(/\.zip$/i, "");
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Locate the expected native executable inside a freshly extracted archive.
 * Exact archive-folder paths are preferred; a bounded walk is a fallback.
 * Symlinks are never followed.
 */
export async function findPandocBinary(
  extractionRoot,
  descriptor,
  expectedFolder,
) {
  const root = resolve(extractionRoot);
  const candidates = [];
  const safeExpected =
    typeof expectedFolder === "string" &&
    expectedFolder.length > 0 &&
    !expectedFolder.includes("/") &&
    !expectedFolder.includes("\\") &&
    expectedFolder !== "." &&
    expectedFolder !== ".."
      ? expectedFolder
      : undefined;

  if (safeExpected !== undefined) {
    candidates.push(join(root, safeExpected, "bin", descriptor.binaryName));
    candidates.push(join(root, safeExpected, descriptor.binaryName));
  }

  let topLevel;
  try {
    topLevel = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new PackagingError(`cannot inspect extracted archive: ${error.message}`);
  }
  for (const entry of topLevel) {
    if (entry.isDirectory()) {
      candidates.push(join(root, entry.name, "bin", descriptor.binaryName));
      candidates.push(join(root, entry.name, descriptor.binaryName));
    } else if (entry.isFile() && entry.name === descriptor.binaryName) {
      candidates.push(join(root, entry.name));
    }
  }
  candidates.push(join(root, "bin", descriptor.binaryName));

  const matches = [];
  for (const candidate of new Set(candidates)) {
    if (!inside(root, candidate)) continue;
    const found = await regularFile(root, candidate);
    if (found !== undefined) matches.push(found);
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    if (safeExpected !== undefined) {
      const preferred = join(root, safeExpected, "bin", descriptor.binaryName);
      if (matches.includes(preferred)) return preferred;
    }
    throw new PackagingError(
      `multiple ${descriptor.binaryName} candidates found under ${root}`,
    );
  }

  const walked = [];
  let visited = 0;
  async function walk(directory, depth) {
    if (depth > MAX_WALK_DEPTH) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      visited++;
      if (visited > MAX_WALK_ENTRIES) {
        throw new PackagingError("extracted archive has too many entries");
      }
      const full = join(directory, entry.name);
      if (!inside(root, full)) {
        throw new PackagingError(`archive entry escapes the extraction root: ${full}`);
      }
      const info = await lstatOptional(full);
      if (info === undefined || info.isSymbolicLink()) continue;
      if (info.isFile() && entry.name === descriptor.binaryName) {
        walked.push(full);
      } else if (info.isDirectory()) {
        await walk(full, depth + 1);
      }
    }
  }
  await walk(root, 0);

  if (walked.length === 1) return walked[0];
  if (walked.length > 1) {
    throw new PackagingError(
      `multiple ${descriptor.binaryName} candidates found under ${root}`,
    );
  }
  throw new PackagingError(
    `could not find ${descriptor.binaryName} in the extracted Pandoc archive`,
  );
}

async function inspectTarget(targetDir) {
  const info = await lstatOptional(targetDir);
  if (info === undefined) return { exists: false, owned: false };
  if (info.isSymbolicLink() || !info.isDirectory()) {
    return { exists: true, owned: false };
  }
  try {
    const recorded = JSON.parse(await readFile(join(targetDir, STAGE_MANIFEST), "utf8"));
    return { exists: true, owned: recorded?.owner === STAGE_OWNER };
  } catch {
    return { exists: true, owned: false };
  }
}

async function assertTargetReplaceable(targetDir) {
  const target = await inspectTarget(targetDir);
  if (target.exists && !target.owned) {
    throw new PackagingError(
      `refusing to replace a Pandoc target not owned by this script: ${targetDir}`,
    );
  }
  return target;
}

function sourceNotice({ manifest, entry, archiveSha256, binaryName, binarySha256 }) {
  return [
    `Pandoc ${manifest.version}`,
    `Source: ${manifest.source}`,
    `Archive: ${entry.url}`,
    `Archive SHA-256: ${archiveSha256}`,
    `Binary: bin/${binaryName}`,
    `Binary SHA-256: ${binarySha256}`,
    "License: GPL-2.0-or-later. See COPYING.md in this directory.",
    "",
  ].join("\n");
}

async function publishStage(stageDir, targetDir, log) {
  await assertTargetReplaceable(targetDir);
  const previous = join(
    dirname(targetDir),
    `.${basename(targetDir)}.previous-${randomSuffix()}`,
  );
  let movedPrevious = false;
  try {
    const target = await inspectTarget(targetDir);
    if (target.exists && !target.owned) {
      throw new PackagingError(
        `refusing to replace a Pandoc target not owned by this script: ${targetDir}`,
      );
    }
    if (target.exists) {
      await rename(targetDir, previous);
      movedPrevious = true;
    }
    try {
      await rename(stageDir, targetDir);
    } catch (error) {
      if (movedPrevious) {
        await rm(targetDir, { recursive: true, force: true });
        await rename(previous, targetDir);
        movedPrevious = false;
      }
      throw error;
    }
    if (movedPrevious) {
      await rm(previous, { recursive: true, force: true });
      movedPrevious = false;
    }
  } finally {
    if (movedPrevious) {
      // Best effort: the previous stage is more valuable than a failed cleanup.
      log(`warning: previous Pandoc stage left at ${previous}`);
    }
  }
}

/**
 * Stage an already-extracted Pandoc tree. Exported so unit tests can exercise
 * path selection, metadata, executable mode and atomic replacement without a
 * real zip or network access.
 */
export async function stageExtractedTree({
  root = ROOT,
  descriptor,
  platform,
  arch,
  manifest,
  entry,
  extractionRoot,
  expectedFolder,
  archiveSha256,
  log = silentLog,
} = {}) {
  const target = descriptor ?? resolvePlatform(platform, arch);
  if (manifest === null || typeof manifest !== "object") {
    throw new PackagingError("Pandoc manifest is required");
  }
  if (entry === null || typeof entry !== "object" || typeof entry.url !== "string") {
    throw new PackagingError("Pandoc manifest entry is required");
  }
  const archiveDigest = normalizeSha256(archiveSha256, "archive sha256");
  const archiveFolderName = expectedFolder ?? archiveFolder(entry.url);
  const binarySource = await findPandocBinary(
    extractionRoot,
    target,
    archiveFolderName,
  );
  const binarySha256 = await sha256File(binarySource);

  const targetsDir = join(root, TARGETS_RELATIVE);
  const targetDir = join(targetsDir, target.target);
  await mkdir(targetsDir, { recursive: true });
  await assertTargetReplaceable(targetDir);

  const stageDir = await mkdtemp(join(targetsDir, `.stage-${target.target}-`));
  let published = false;
  try {
    const stageBin = join(stageDir, "bin");
    await mkdir(stageBin, { recursive: true });
    const stagedBinary = join(stageBin, target.binaryName);
    await copyFile(binarySource, stagedBinary);
    await chmod(stagedBinary, 0o755);

    const licenseSource = join(root, LICENSE_RELATIVE);
    await copyFile(licenseSource, join(stageDir, "COPYING.md"));
    const notice = sourceNotice({
      manifest,
      entry,
      archiveSha256: archiveDigest,
      binaryName: target.binaryName,
      binarySha256,
    });
    await writeFile(join(stageDir, "SOURCE.txt"), notice, { mode: 0o644 });
    await writeFile(join(stageDir, "NOTICE.txt"), notice, { mode: 0o644 });

    const recorded = {
      schemaVersion: 1,
      owner: STAGE_OWNER,
      platform: target.platform,
      arch: target.arch,
      target: target.target,
      pandocVersion: manifest.version,
      source: manifest.source,
      archiveUrl: entry.url,
      archiveSha256: archiveDigest,
      binary: `bin/${target.binaryName}`,
      binarySha256,
    };
    await writeFile(
      join(stageDir, STAGE_MANIFEST),
      `${JSON.stringify(recorded, null, 2)}\n`,
      { mode: 0o644 },
    );

    await publishStage(stageDir, targetDir, log);
    published = true;
    return {
      targetDir,
      binaryPath: join(targetDir, "bin", target.binaryName),
      binarySha256,
      archiveSha256: archiveDigest,
      manifest: recorded,
    };
  } finally {
    if (!published) {
      await rm(stageDir, { recursive: true, force: true });
    }
  }
}

/**
 * Download (or reuse) the pinned archive and atomically stage native Pandoc.
 */
export async function stagePandoc({
  root = ROOT,
  platform,
  arch,
  archivePath,
  fetchImpl = globalThis.fetch,
  extractImpl,
  log = silentLog,
} = {}) {
  const descriptor = resolvePlatform(platform, arch);
  const manifest = await loadManifest({ root });
  const entry = pandocEntry(manifest, descriptor);
  const targetsDir = join(root, TARGETS_RELATIVE);
  const targetDir = join(targetsDir, descriptor.target);
  await mkdir(targetsDir, { recursive: true });
  await assertTargetReplaceable(targetDir);

  let archive;
  if (archivePath !== undefined) {
    const digest = await assertDigest(archivePath, entry.sha256);
    archive = { path: resolve(archivePath), sha256: digest, cached: false };
  } else {
    archive = await obtainArchive({
      cacheDir: join(root, CACHE_RELATIVE),
      url: entry.url,
      sha256: entry.sha256,
      fetchImpl,
      log,
    });
  }

  const extractionRoot = await mkdtemp(join(targetsDir, ".extract-"));
  try {
    await extractArchive(archive.path, extractionRoot, extractImpl);
    return await stageExtractedTree({
      root,
      descriptor,
      manifest,
      entry,
      extractionRoot,
      expectedFolder: archiveFolder(entry.url),
      archiveSha256: archive.sha256,
      log,
    });
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

export async function loadPackageMetadata({ root = ROOT } = {}) {
  const packagePath = join(root, "package.json");
  let value;
  try {
    value = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    throw new PackagingError(`cannot read ${packagePath}: ${error.message}`);
  }
  if (typeof value?.name !== "string" || value.name.length === 0) {
    throw new PackagingError("package.json name is missing");
  }
  if (typeof value?.version !== "string" || value.version.length === 0) {
    throw new PackagingError("package.json version is missing");
  }
  return { name: value.name, version: value.version };
}

function resolveElectronBuilderCli() {
  const require = createRequire(import.meta.url);
  let cliPath;
  try {
    cliPath = require.resolve("electron-builder/cli.js");
  } catch (error) {
    try {
      const mainPath = require.resolve("electron-builder");
      const candidate = join(dirname(mainPath), "cli.js");
      if (!existsSync(candidate)) throw error;
      cliPath = candidate;
    } catch {
      throw new PackagingError(
        `cannot resolve the local electron-builder CLI: ${error.message}`,
      );
    }
  }

  let directory = dirname(cliPath);
  let packagePath;
  for (let depth = 0; depth < 10; depth++) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) {
      packagePath = candidate;
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (packagePath === undefined) {
    throw new PackagingError("cannot find electron-builder package.json");
  }
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new PackagingError(`cannot read electron-builder package.json: ${error.message}`);
  }
  if (metadata.name !== "electron-builder") {
    throw new PackagingError(`unexpected electron-builder package: ${metadata.name}`);
  }
  const declared =
    typeof metadata.bin === "string"
      ? metadata.bin
      : metadata.bin?.["electron-builder"];
  if (typeof declared !== "string" || declared.length === 0) {
    throw new PackagingError("electron-builder package has no CLI bin entry");
  }
  const declaredPath = resolve(dirname(packagePath), declared);
  if (realpathSync(declaredPath) !== realpathSync(cliPath)) {
    throw new PackagingError(
      `electron-builder CLI bin does not match the local package: ${declared}`,
    );
  }
  return cliPath;
}

function buildArguments(descriptor) {
  const args = [
    "--config",
    "electron-builder.json",
    descriptor.platform === "darwin" ? "--mac" : "--win",
    descriptor.platform === "darwin" ? "dmg" : "nsis",
    descriptor.arch === "arm64" ? "--arm64" : "--x64",
    "--publish",
    "never",
  ];
  return args;
}

function sanitizedBuildEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CSC_") || key.startsWith("WIN_CSC_")) {
      delete env[key];
    }
  }
  // Force ad-hoc signing on macOS and never auto-discover a keychain identity.
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  return env;
}

function killChildTree(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return;
  }
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error.code !== "ESRCH") {
      try {
        child.kill(signal);
      } catch {
        // The process already exited.
      }
    }
  }
}

/**
 * Run the local electron-builder Node CLI for exactly one target.
 * Captures a bounded tail of output and enforces a wall-clock timeout.
 */
export async function runBuilder({
  root = ROOT,
  platform,
  arch,
  timeoutMs = BUILD_TIMEOUT_MS,
  log = silentLog,
} = {}) {
  const descriptor = resolvePlatform(platform, arch);
  const metadata = await loadPackageMetadata({ root });
  const cliPath = resolveElectronBuilderCli();
  const args = [cliPath, ...buildArguments(descriptor)];

  log(
    `building ${metadata.name} ${metadata.version} for ${descriptor.target} (ad-hoc, no publish)`,
  );

  const child = spawn(process.execPath, args, {
    cwd: root,
    env: sanitizedBuildEnvironment(),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let timedOut = false;
  let receivedSignal = null;
  let forceKillTimer;
  const started = Date.now();

  const append = (chunk) => {
    output = (output + chunk).slice(-MAX_CAPTURE_BYTES);
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    append(chunk);
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    append(chunk);
    process.stderr.write(chunk);
  });

  const onSignal = (signal) => {
    receivedSignal = signal;
    killChildTree(child, signal);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const timeout = setTimeout(() => {
    timedOut = true;
    log(`electron-builder exceeded ${timeoutMs}ms; terminating its process group`);
    killChildTree(child, "SIGTERM");
    forceKillTimer = setTimeout(() => {
      killChildTree(child, "SIGKILL");
    }, 5_000);
    forceKillTimer.unref?.();
  }, timeoutMs);
  timeout.unref?.();

  try {
    return await new Promise((resolvePromise, rejectPromise) => {
      child.once("error", (error) => {
        rejectPromise(new PackagingError(`cannot start electron-builder: ${error.message}`));
      });
      child.once("close", (code, signal) => {
        if (timedOut) {
          rejectPromise(
            new BuildError(
              `electron-builder timed out after ${timeoutMs}ms`,
              { exitCode: code, signal, output },
            ),
          );
          return;
        }
        if (receivedSignal !== null) {
          process.exitCode =
            128 + (constants.signals[receivedSignal] ?? 0);
          rejectPromise(
            new BuildError(
              `electron-builder terminated by ${receivedSignal}`,
              { exitCode: code, signal, output },
            ),
          );
          return;
        }
        if (code !== 0) {
          rejectPromise(
            new BuildError(
              `electron-builder exited with status ${String(code)}${signal ? ` (${signal})` : ""}`,
              { exitCode: code, signal, output },
            ),
          );
          return;
        }
        log(`electron-builder completed in ${Date.now() - started}ms`);
        resolvePromise({ code, signal, output });
      });
    });
  } finally {
    clearTimeout(timeout);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

/**
 * Generate SHA256SUMS for top-level DMG/EXE/blockmap artifacts.
 * Unpacked directories, builder YAML and all other files are excluded.
 */
export async function generateChecksums({
  root = ROOT,
  releaseDir = join(root, "release"),
  log = silentLog,
} = {}) {
  let entries;
  try {
    entries = await readdir(releaseDir, { withFileTypes: true });
  } catch (error) {
    throw new PackagingError(`cannot read release directory ${releaseDir}: ${error.message}`);
  }
  const artifacts = entries
    .filter(
      (entry) =>
        entry.isFile() && /\.(?:dmg|exe|blockmap)$/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (artifacts.length === 0) {
    throw new PackagingError(`no DMG, EXE or blockmap artifacts found in ${releaseDir}`);
  }

  const lines = [];
  for (const name of artifacts) {
    const digest = await sha256File(join(releaseDir, name));
    lines.push(`${digest}  ${name}`);
  }
  const destination = join(releaseDir, "SHA256SUMS");
  const temporary = join(releaseDir, `.SHA256SUMS.${randomSuffix()}.tmp`);
  try {
    await writeFile(temporary, `${lines.join("\n")}\n`, { mode: 0o644 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  log(`wrote ${destination}`);
  return { path: destination, artifacts: artifacts.map((name) => join(releaseDir, name)) };
}

/**
 * CLI entry point. Importable without side effects.
 */
export async function main(argv = process.argv.slice(2), { root = ROOT, log = defaultLog } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const metadata = await loadPackageMetadata({ root });
  const descriptor = resolvePlatform(options.platform, options.arch);
  log(
    `Slide Studio ${metadata.version}: ${descriptor.target}${options.stageOnly ? " (stage only)" : ""}`,
  );

  await stagePandoc({
    root,
    platform: descriptor.platform,
    arch: descriptor.arch,
    log,
  });

  if (options.stageOnly) {
    log("Pandoc staged; skipping electron-builder");
    return 0;
  }

  await runBuilder({
    root,
    platform: descriptor.platform,
    arch: descriptor.arch,
    log,
  });
  await generateChecksums({ root, log });
  return 0;
}

function isMainModule() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(resolve(entry)).href === import.meta.url;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`package-desktop: ${message}\n`);
    if (process.exitCode === undefined) process.exitCode = 1;
  });
}
