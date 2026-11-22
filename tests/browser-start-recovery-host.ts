/** Child host for the abrupt-exit case in browser-start-recovery.test.ts. */
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/main/browser';

const runtime = new BrowserRuntime({
  storageDir: process.argv[2],
  binaryPath: process.env.ATHENA_TEST_CHROME,
  onState() {},
  onFrame() {},
  onStep() {},
  onSelected() {},
  onHumanTakeover() {},
});
await runtime.start();
const drafts = [
  { id: runtime.getState().activeTabId!, value: 'Unsaved first draft' },
  { id: (await runtime.newTab()).id, value: 'Unsaved second draft' },
];
for (const { id, value } of drafts) {
  const edit = await runtime.nativeEvaluate(
    id,
    `document.body.innerHTML='<input>'; document.querySelector('input').value=${JSON.stringify(value)}`,
  );
  assert.equal(edit.value, value);
}
const activeTabId = process.argv[3] === 'first' ? drafts[0].id : drafts[1].id;
await runtime.switchTab(activeTabId);
const field = (await runtime.queryElements({ selector: 'input' })).elements[0];
await runtime.selectElement(field.ref);
const selected = await runtime.nativeEvaluate(
  activeTabId,
  `new Promise(resolve => requestAnimationFrame(() => {
    window.oldAthenaSelection = document.querySelector('[data-workbench-overlay]');
    resolve(Boolean(window.oldAthenaSelection));
  }))`,
);
assert.equal(selected.value, true);
process.send!({ endpoint: runtime.getNativeConnection().endpoint, activeTabId, drafts });
