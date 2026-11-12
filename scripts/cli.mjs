#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url), electron = require('electron');
if (!process.env.SLIDE_STUDIO_PANDOC && !process.argv.includes('--help') && !process.argv.includes('-h') && !(process.argv[2]==='audit' && process.argv[3]==='tools')) { const {ensurePandoc} = await import('./setup-pandoc.mjs'); await ensurePandoc(); }
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [resolve(root, 'dist/apps/desktop/main.js'), '--studio-cli', ...process.argv.slice(2)], {env, stdio: 'inherit'});
child.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
