import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runs the two scripts that produce screenshots with `--screenshots`, then
 * lists every expected file with its size. No result is invented: a missing
 * file is printed as MISSING and the command fails.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCREENSHOT_DIR = join(ROOT, 'evidence', 'screenshots');

const RUNS = [
  {
    script: 'evidence-kill-recovery.ts',
    files: ['kill-1-before.png', 'kill-2-after-kill.png', 'kill-3-after-recovery.png'],
  },
  {
    script: 'evidence-all-statuses.ts',
    files: ['all-statuses.png', 'dead-letter.png'],
  },
] as const;

function run(script: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join('scripts', script), '--screenshots'],
      { cwd: ROOT, stdio: 'inherit', windowsHide: true },
    );
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${script} exited with code=${code} signal=${signal}`));
    });
  });
}

let failed = false;

for (const { script } of RUNS) {
  console.log(`\n=== ${script} --screenshots ===`);
  try {
    await run(script);
  } catch (error) {
    failed = true;
    console.error(`FAILED: ${(error as Error).message}`);
  }
}

console.log('\nScreenshots written to evidence/screenshots:');
let total = 0;
let count = 0;
for (const { files } of RUNS) {
  for (const file of files) {
    count += 1;
    const path = join(SCREENSHOT_DIR, file);
    if (!existsSync(path)) {
      failed = true;
      console.log(`  ${file.padEnd(28)} MISSING`);
      continue;
    }
    const bytes = statSync(path).size;
    total += bytes;
    console.log(
      `  ${file.padEnd(28)} ${String(bytes).padStart(10)} bytes  (${(bytes / 1024).toFixed(1)} KiB)`,
    );
  }
}
console.log(`  ${`${count} files`.padEnd(28)} ${String(total).padStart(10)} bytes total`);

if (failed) process.exitCode = 1;
