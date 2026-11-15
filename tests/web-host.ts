/** A host process for web-lifecycle.test.ts: starts a task, reports its processes and idles. */
import { webFixture } from './web-fixture';

const f = await webFixture('/plain');
const task = await f.begin('host');
console.log(
  JSON.stringify({
    daemon: task.worker.daemon.pid,
    directory: task.worker.directory,
    browser: (f.browser as any).process?.pid,
    temp: f.directory,
  }),
);
setInterval(() => {}, 1000);
