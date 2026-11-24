// Validate the generated-project inputs; this does not replace signed-device verification.
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--test', new URL('./check-vault-autofill-config.test.mjs', import.meta.url).pathname], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
