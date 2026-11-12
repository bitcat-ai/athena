import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserRuntime, discoverChrome } from '../src/main/browser';

test(
  'browser discovery falls back from a moved installation without launching it',
  { skip: process.platform !== 'darwin' },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'athena-browser-discovery-'));
    const application = path.join(directory, 'Google Chrome.app');
    const binary = path.join(application, 'Contents/MacOS/Google Chrome');
    const previous = process.env.ATHENA_CHROME_PATH;
    let runtime: BrowserRuntime | undefined;
    try {
      await mkdir(path.dirname(binary), { recursive: true });
      await writeFile(binary, '#!/bin/sh\nexit 91\n', { mode: 0o700 });
      const plist = path.join(application, 'Contents/Info.plist');
      const metadata = (id: string) =>
        `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>Google Chrome</string></dict></plist>`;
      await writeFile(plist, metadata('com.example.NotChrome'));
      assert.equal(await discoverChrome(application), undefined);
      await writeFile(plist, metadata('com.google.Chrome'));
      assert.equal(await discoverChrome(application), binary);
      assert.equal(await discoverChrome(binary), binary);
      process.env.ATHENA_CHROME_PATH = application;
      runtime = new BrowserRuntime({
        storageDir: path.join(directory, 'browser'),
        binaryPath: path.join(directory, 'moved.app'),
        onState() {},
        onFrame() {},
        onStep() {},
        onSelected() {},
        onHumanTakeover() {},
      });
      assert.equal(await runtime.detectInstallation(), binary);
      assert.equal(runtime.getState().binaryPath, binary);
      assert.equal(runtime.getState().status, 'stopped');
      // A manual selection still validates exactly the selected app.
      assert.equal(await discoverChrome(path.join(directory, 'moved.app')), undefined);
    } finally {
      if (previous === undefined) delete process.env.ATHENA_CHROME_PATH;
      else process.env.ATHENA_CHROME_PATH = previous;
      await runtime?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
