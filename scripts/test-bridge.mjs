import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['--test', 'dist/tests/bridge/*.test.js'], {
  stdio: 'inherit',
  env: { ...process.env, SLIDE_STUDIO_BRIDGE_E2E: '1' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
