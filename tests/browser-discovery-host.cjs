// Isolate installation visibility while using the real app, CDP and agent-browser worker.
const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const profile = process.env.WORKBENCH_USER_DATA_DIR;
if (!profile) throw new Error('Browser discovery tests require an isolated profile');
const execFile = promisify(childProcess.execFile);
Object.defineProperty(childProcess.execFile, promisify.custom, {
  configurable: true,
  value: async (command, args, options) => {
    if (command === '/usr/bin/osascript') {
      const registered = path.join(profile, 'registered-browser.txt');
      return {
        stdout: JSON.stringify(
          fs.existsSync(registered) ? fs.readFileSync(registered, 'utf8') : null,
        ),
        stderr: '',
      };
    }
    if (command === '/usr/bin/mdfind') {
      const index = path.join(profile, 'indexed-browser.txt');
      return {
        stdout: fs.existsSync(index) ? fs.readFileSync(index, 'utf8') + '\0' : '',
        stderr: '',
      };
    }
    if (command === '/usr/bin/plutil' && !args.some((value) => value.startsWith(profile + '/')))
      throw Object.assign(new Error('Application is outside the installation fixture'), {
        code: 'ENOENT',
      });
    return execFile(command, args, options);
  },
});
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  if (args[2]?.env?.AGENT_BROWSER_DAEMON === '1') global.__discoveryWebWorker = child;
  return child;
};
require('./electron-background.cjs');
