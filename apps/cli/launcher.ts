import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../../packages/core/src/atomic.js';
import { assetPath } from '../../packages/core/src/assets.js';

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
/** Private launcher on each AI child's PATH; never changes the system PATH. */
export async function prepareLauncher(directory: string, executable: string, entry?: string) {
  await mkdir(directory, {recursive: true, mode: 0o700});
  const args = [executable, ...(entry ? [entry] : []), '--studio-cli'];
  if (process.platform === 'win32') {
    const command = args.map(value => '"' + value.replaceAll('%', '%%') + '"').join(' ');
    await atomicWriteFile(join(directory, 'slide-studio.cmd'), `@echo off\r\nset "ELECTRON_RUN_AS_NODE="\r\nset "SLIDE_STUDIO_ELECTRON_HOME="\r\n${command} %*\r\nexit /b %ERRORLEVEL%\r\n`, 0o600);
  } else {
    const bridge = process.platform === 'darwin' ? `if [ "$SLIDE_STUDIO_SANDBOX" = "1" ]; then\n  umask 077\n  exec /usr/bin/osascript -l JavaScript ${shellQuote(assetPath('ai', 'cli-bridge-macos.js'))} "$@"\nfi\n` : '';
    await atomicWriteFile(join(directory, 'slide-studio'), `#!/bin/sh\nunset ELECTRON_RUN_AS_NODE SLIDE_STUDIO_ELECTRON_HOME\n${bridge}exec ${args.map(shellQuote).join(' ')} "$@"\n`, 0o700);
  }
  return directory;
}
