import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

/** Browser for isolated renderer tests only; this does not validate the web executor. */
export function uiBrowserExecutable(): string {
  const configured = process.env.WORKBENCH_TEST_BROWSER_EXECUTABLE;
  if (configured) {
    if (!path.isAbsolute(configured) || !existsSync(configured) || !statSync(configured).isFile())
      throw new Error(
        'WORKBENCH_TEST_BROWSER_EXECUTABLE must point to an installed browser executable.',
      );
    return configured;
  }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    chromium.executablePath(),
  ];
  const found = candidates.find((file) => existsSync(file) && statSync(file).isFile());
  if (!found)
    throw new Error('No browser for renderer tests; set WORKBENCH_TEST_BROWSER_EXECUTABLE.');
  return found;
}
