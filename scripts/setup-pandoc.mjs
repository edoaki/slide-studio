#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import https from "node:https";
import extract from "@electron-internal/extract-zip";

export const PANDOC_VERSION = "3.9";
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pandocRoot = resolve(root, "resources/pandoc");
const localBinDirectory = resolve(pandocRoot, "bin");
const defaultManifest = resolve(pandocRoot, "manifest.json");

function log(message) {
  process.stdout.write(`setup-pandoc: ${message}\n`);
}

function fail(message) {
  process.stderr.write(`setup-pandoc: ${message}\n`);
  process.exitCode = 1;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    let total = 0;
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) {
        stream.destroy(new Error(`${path} is larger than ${MAX_DOWNLOAD_BYTES} bytes`));
        return;
      }
      hash.update(bytes);
    });
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function requestOnce(url) {
  return new Promise((resolveResponse, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`invalid download URL: ${url}`));
      return;
    }
    if (parsed.protocol !== "https:") {
      reject(new Error(`refusing a non-HTTPS download URL: ${url}`));
      return;
    }
    const request = https.get(parsed, {
      headers: {
        "user-agent": "slide-studio-setup-pandoc/0.1",
        accept: "application/octet-stream",
      },
      timeout: DOWNLOAD_TIMEOUT_MS,
    }, resolveResponse);
    request.on("timeout", () => {
      request.destroy(new Error("download timed out"));
    });
    request.on("error", reject);
  });
}

async function download(url, destination) {
  let current = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await requestOnce(current);
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      const location = response.headers.location;
      response.resume();
      if (typeof location !== "string" || location.length === 0) {
        throw new Error(`redirect without a Location header from ${current}`);
      }
      current = new URL(location, current).toString();
      continue;
    }
    if (status !== 200) {
      response.resume();
      throw new Error(`download failed with HTTP ${status}: ${current}`);
    }
    const declared = Number(response.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      response.destroy();
      throw new Error(`download is larger than ${MAX_DOWNLOAD_BYTES} bytes`);
    }
    let total = 0;
    const hash = createHash("sha256");
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        total += chunk.length;
        if (total > MAX_DOWNLOAD_BYTES) {
          callback(new Error(`download is larger than ${MAX_DOWNLOAD_BYTES} bytes`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(response, meter, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
    return { sha256: hash.digest("hex"), bytes: total };
  }
  throw new Error(`too many redirects while downloading ${url}`);
}

async function assertNoSymlinks(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`extracted archive contains a symbolic link: ${entry.name}`);
    }
  }
}

async function findPandoc(directory, binaryName) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name !== binaryName) continue;
    matches.push(join(entry.parentPath, entry.name));
  }
  return matches.find((path) => basename(dirname(path)) === "bin") ?? matches[0];
}

function installedVersionMatches(binary) {
  if (!existsSync(binary)) return false;
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
    env: process.env,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return false;
  const firstLine = result.stdout.split(/\r?\n/, 1)[0] ?? "";
  const escaped = PANDOC_VERSION.replace(/\./g, "\\.");
  return new RegExp(`^pandoc\\s+${escaped}(?:\\s|$)`).test(firstLine.trim());
}

async function stampMatches(file, key, sha256) {
  try {
    const stamp = await readFile(file, "utf8");
    return stamp === `${PANDOC_VERSION}\n${key}\n${sha256}\n`;
  } catch {
    return false;
  }
}

async function installFromZip(zip, binDirectory, binaryName, native) {
  const extraction = await mkdtemp(join(tmpdir(), "slide-studio-pandoc-"));
  try {
    await extract(zip, { dir: extraction });
    await assertNoSymlinks(extraction);
    const found = await findPandoc(extraction, binaryName);
    if (found === undefined) {
      throw new Error(`the archive does not contain ${binaryName}`);
    }
    await mkdir(binDirectory, { recursive: true });
    const binary = join(binDirectory, binaryName);
    const temporary = join(binDirectory, `.${binaryName}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await copyFile(found, temporary);
      if (process.platform !== "win32") await chmod(temporary, 0o755);
      await rename(temporary, binary);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    if (native && !installedVersionMatches(binary)) {
      await rm(binary, { force: true }).catch(() => {});
      throw new Error(`the downloaded Pandoc did not report version ${PANDOC_VERSION}`);
    }
    return binary;
  } finally {
    await rm(extraction, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function writeStamp(binDirectory, key, sha256) {
  await mkdir(binDirectory, { recursive: true });
  const target = join(binDirectory, ".pandoc-version");
  const temporary = join(binDirectory, `.pandoc-version.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${PANDOC_VERSION}\n${key}\n${sha256}\n`, { mode: 0o644 });
  await rename(temporary, target);
}

function normalizePlatform(value) {
  if (value === "mac" || value === "macos" || value === "darwin") return "darwin";
  if (value === "win" || value === "windows" || value === "win32") return "win32";
  return value;
}

/**
 * Download, verify and install Pandoc for a target. `destination` is a directory
 * that receives `bin/pandoc` or `bin/pandoc.exe`. Foreign targets are staged but
 * never executed. Packaging code can import this helper; the CLI uses defaults.
 *
 * Packaging example:
 *   await ensurePandoc({ platform: "win32", arch: "x64",
 *     destination: resolve("resources/pandoc/targets/win32-x64") });
 */
export async function ensurePandoc(options = {}) {
  const platform = normalizePlatform(options.platform ?? process.platform);
  const arch = options.arch ?? process.arch;
  const key = `${platform}-${arch}`;
  const destination = resolve(options.destination ?? localBinDirectory);
  const manifestPath = resolve(options.manifestPath ?? defaultManifest);
  const binDirectory = join(destination, "bin");
  const binaryName = platform === "win32" ? "pandoc.exe" : "pandoc";
  const binary = join(binDirectory, binaryName);
  const stamp = join(binDirectory, ".pandoc-version");
  const native = platform === process.platform && arch === process.arch;

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== PANDOC_VERSION) {
    throw new Error(`manifest version is ${String(manifest.version)}, expected ${PANDOC_VERSION}`);
  }
  const entry = manifest.platforms?.[key];
  if (entry === undefined) throw new Error(`manifest has no entry for ${key}`);
  const url = entry.url;
  const expectedSha = String(entry.sha256 ?? "").toLowerCase();
  if (typeof url !== "string" || !url.startsWith("https://")) {
    throw new Error(`manifest URL for ${key} must use HTTPS`);
  }
  if (!SHA256_PATTERN.test(expectedSha)) {
    throw new Error(`manifest SHA-256 for ${key} is invalid`);
  }

  if (native) {
    if (existsSync(binary) && process.platform !== "win32") {
      await chmod(binary, 0o755).catch(() => {});
    }
    if (native && installedVersionMatches(binary)) {
      await writeStamp(binDirectory, key, expectedSha).catch(() => {});
      return { binary, version: PANDOC_VERSION, platform, arch, downloaded: false, native };
    }
  } else if (existsSync(binary) && await stampMatches(stamp, key, expectedSha)) {
    return { binary, version: PANDOC_VERSION, platform, arch, downloaded: false, native };
  }

  const cacheDirectory = destination === localBinDirectory
    ? join(localBinDirectory, ".cache")
    : join(tmpdir(), "slide-studio-pandoc-cache");
  await mkdir(cacheDirectory, { recursive: true });
  const cachedZip = resolve(cacheDirectory, `pandoc-${PANDOC_VERSION}-${key}.zip`);
  let zip = cachedZip;
  let downloaded = false;

  if (await isFile(cachedZip)) {
    const cachedSha = await sha256File(cachedZip);
    if (cachedSha !== expectedSha) await rm(cachedZip, { force: true });
  }

  if (!(await isFile(zip))) {
    const temporary = resolve(cacheDirectory, `.download.${process.pid}.${randomUUID()}.tmp`);
    try {
      const result = await download(url, temporary);
      if (result.sha256 !== expectedSha) {
        throw new Error(
          `SHA-256 mismatch for ${url}: expected ${expectedSha}, got ${result.sha256}`,
        );
      }
      await rename(temporary, cachedZip);
      zip = cachedZip;
      downloaded = true;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  const installedBinary = await installFromZip(zip, binDirectory, binaryName, native);
  await writeStamp(binDirectory, key, expectedSha);
  return {
    binary: installedBinary,
    version: PANDOC_VERSION,
    platform,
    arch,
    downloaded,
    native,
  };
}

function supportedLocalPlatform() {
  if (process.platform === "darwin") return process.arch === "arm64" || process.arch === "x64";
  if (process.platform === "win32") return process.arch === "x64";
  return false;
}

async function cli() {
  if (!supportedLocalPlatform()) {
    log(`この環境では同梱Pandocを自動取得しません (platform=${process.platform}, arch=${process.arch})。`);
    return;
  }
  const result = await ensurePandoc();
  log(`Pandoc ${PANDOC_VERSION} を準備しました: ${result.binary}`);
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await cli();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
