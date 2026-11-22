/** Real Chrome and agent-browser, with the cursor observed independently via CDP. No model turns. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CdpConnection } from '../src/main/browser-cdp';
import type { BrowserFrame } from '../src/shared/types';
import { until, webFixture } from './web-fixture';

const out = process.env.ATHENA_MOTION_REPORT || 'test-results/cursor-motion-performance';
const baseline = process.env.ATHENA_MOTION_BASELINE === '1';
await mkdir(out, { recursive: true });
let times: number[] = [],
  capture = false,
  preview = '',
  captureAfter = Infinity;
const f = await webFixture('/popup', (frame?: BrowserFrame) => {
  const now = Date.now();
  if (!capture) return;
  times.push(now);
  if (!preview && now >= captureAfter && frame?.data) preview = frame.data;
});
let debug: CdpConnection | undefined;
const p95 = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null;
};
try {
  const { page } = await f.begin('cursor-motion');
  await f.state(
    `document.body.innerHTML = '<main style="width:75%;margin:20px auto"><section><h1 style="margin:0">Report</h1><p class="subtitle" style="margin:0">Current details</p></section><div class="rows"></div></main>';
     document.querySelector('.rows').innerHTML = Array.from({length: 48}, (_, i) =>
       '<p class="row" style="height:48px">Row ' + i + '</p>').join('');
     true`,
  );
  const heading = (await f.browser.queryElements({ selector: 'h1' })).elements[0];
  await f.browser.setElementFeedback(heading.ref, 'working');
  await f.browser.setElementFeedback(heading.ref, null);
  const port = (
    await readFile(
      path.join(f.directory, 'browser/agent-browser-profile/DevToolsActivePort'),
      'utf8',
    )
  ).split('\n')[0];
  const targets: Array<{ id: string; webSocketDebuggerUrl: string }> = await (
    await fetch('http://127.0.0.1:' + port + '/json/list')
  ).json();
  debug = await CdpConnection.connect(
    targets.find((t) => t.id === f.browser.getState().activeTabId)!.webSocketDebuggerUrl,
  );
  // Resolve the bridge's closed shadow root without modifying the bridge or the inspected webpage's prototypes.
  const dom = await debug.call('DOM.getDocument', { depth: -1, pierce: true });
  function shadow(node: any): number | undefined {
    if (node.attributes?.includes('data-workbench-overlay'))
      return node.shadowRoots?.[0]?.backendNodeId;
    for (const child of node.children || []) {
      const id = shadow(child);
      if (id) return id;
    }
  }
  const rootId = shadow(dom.root);
  assert(rootId, 'missing overlay root');
  const ref = await debug.call('DOM.resolveNode', { backendNodeId: rootId });
  await debug.call('Runtime.callFunctionOn', {
    objectId: ref.object.objectId,
    functionDeclaration: `function(){globalThis.__motionRoot=this;}`,
  });
  await f.state(`window.motionRows=[];window.motionOn=false;window.phase=0;function tick(now){
    if(window.motionOn){
      const cursors=[...window.__motionRoot.querySelectorAll('.swarm .sw-cur')];
      const visible=[];
      for (const c of cursors) {
        const svg=c.querySelector('svg.'+c.dataset.mode);
        if (!svg || Number(getComputedStyle(c).opacity)<.05) continue;
        const r=svg.getBoundingClientRect();
        if (r.width>0 && r.height>0 && r.right>0 && r.bottom>0 && r.left<innerWidth && r.top<innerHeight)
          visible.push([Math.round(r.left),Math.round(r.top)].join(','));
      }
      window.motionRows.push([Date.now(),now,visible.length,visible.join(' '),window.phase,scrollY]);
    }
    requestAnimationFrame(tick);
  }requestAnimationFrame(tick);true`);
  type Row = [number, number, number, string, number, number];
  const report: Record<string, unknown>[] = [];
  async function measure(
    label: string,
    action: () => Promise<unknown>,
    hold: number | (() => Promise<void>),
  ) {
    await f.state('window.motionRows=[];window.motionOn=true;window.phase=0;true');
    capture = true;
    times = [];
    preview = '';
    const start = Date.now();
    captureAfter = start + 300;
    let receiptMs: number;
    try {
      await action();
      receiptMs = Date.now() - start;
      if (typeof hold === 'number') await delay(hold);
      else await hold();
    } finally {
      capture = false;
    }
    const rows: Row[] = await f.state('window.motionOn=false;window.motionRows');
    const active = rows.filter((r) => r[0] >= start && r[2] > 0);
    const stamps = times.filter(
      (t) => active.length && t >= active[0][0] && t <= active.at(-1)![0],
    );
    // Only adjacent visible samples belong to the same run of animation. Retain stalls of any length.
    const intervals = rows.flatMap((row, index) => {
      const previous = rows[index - 1];
      return previous?.[2] && previous[0] >= start && row[2]
        ? [Math.round((row[1] - previous[1]) * 10) / 10]
        : [];
    });
    const hostIntervals = stamps.slice(1).map((stamp, index) => stamp - stamps[index]);
    const phases = [...new Set(active.map((r) => r[4]).filter(Boolean))];
    report.push({
      label,
      receiptMs,
      firstVisibleCursorMs: active.length ? active[0][0] - start : null,
      visibleAnimationFrames: active.length,
      distinctCursorPositions: new Set(active.map((r) => r[3])).size,
      hostCapturedFrames: stamps.length,
      p95HostIntervalMs: p95(hostIntervals),
      p95VisibleRafIntervalMs: p95(intervals),
      maxRafIntervalMs: intervals.length ? Math.max(...intervals) : null,
      phaseCoverage: phases,
      lastScroll: rows.at(-1)?.[5],
      maxScroll: Math.max(0, ...rows.map((r) => r[5])),
    });
    if (preview)
      await writeFile(path.join(out, label + '.jpg'), Buffer.from(preview.split(',')[1], 'base64'));
    console.log(JSON.stringify(report.at(-1)));
    if (!baseline) {
      assert(active.length > 1, label + ' must actually draw a cursor');
      assert(new Set(active.map((r) => r[3])).size > 1, label + ' must move it');
    }
    return phases;
  }
  let layoutEditId = '';
  for (let i = 0; i < 3; i++) {
    await measure(
      'text-' + i,
      () => f.call('workbench_browser_edit', { ref: heading.ref, text: 'Report ' + i }),
      950,
    );
    assert.equal(await f.state("document.querySelector('h1').textContent"), 'Report ' + i);
    await delay(1000);
  }
  await measure(
    'layout',
    async () => {
      const r = await f.runtime.callTool(
        'workbench_browser_restyle',
        {},
        { ref: heading.ref, direction: 'row', revision: f.browser.previewRevision },
      );
      assert(!r.isError, r.text);
      const applied = JSON.parse(r.text);
      assert(applied.applied, r.text);
      layoutEditId = applied.editId;
    },
    1100,
  );
  assert(
    await f.state(
      `document.querySelector('h1').getBoundingClientRect().right<=document.querySelector('.subtitle').getBoundingClientRect().left+1`,
    ),
  );
  await delay(900);
  await measure(
    'undo-layout',
    () => f.call('workbench_browser_undo', { editId: layoutEditId }),
    1100,
  );
  assert(
    await f.state(
      `document.querySelector('h1').getBoundingClientRect().bottom <= document.querySelector('.subtitle').getBoundingClientRect().top + 1`,
    ),
    'undo should return the subtitle below the heading',
  );
  await delay(900);
  const phases = await measure(
    'six-script-edits',
    () =>
      f.call('web_run', {
        code: `
          const page = browser.page(${page});
          for (let i = 1; i <= 6; i++) {
            await page.evaluateInPage(i => {
              window.phase = i;
              document.querySelector('h1').textContent = 'Script ' + i;
            }, i);
            await sleep(500);
          }
          return 'finished';`,
      }),
    650,
  );
  assert.equal(await f.state("document.querySelector('h1').textContent"), 'Script 6');
  if (!baseline)
    assert.deepEqual(phases, [1, 2, 3, 4, 5, 6], 'visible cursor during each spaced script edit');
  await delay(1300);
  await measure(
    'long-page',
    () =>
      f.call('web_run', {
        code: `const page = browser.page(${page});
          await page.evaluateInPage(() => {
            const css = document.createElement('style');
            css.textContent = 'h1,.row:nth-child(9n) {background:rgb(224,224,224) !important}';
            document.head.append(css);
          });
          return 'restyled';`,
      }),
    () => until(() => f.state('scrollY>240'), 'tour should reach offscreen edits', 10000),
  );
  await f.browser.dispatchInput({ type: 'wheel', x: 260, y: 200, deltaX: 0, deltaY: 180 });
  await delay(300);
  const takeover = await f.state(
    `({scroll:scrollY,cursors:window.__motionRoot.querySelectorAll('.swarm .sw-cur').length, active:document.getAnimations().length})`,
  );
  assert.equal(takeover.cursors, 0, 'human takeover must clear the cursors');
  const preserved = takeover.scroll;
  await delay(400);
  assert.equal(
    await f.state('scrollY'),
    preserved,
    'an interrupted tour must not restore an old viewport',
  );
  await writeFile(
    path.join(out, 'measurements.json'),
    JSON.stringify({ baseline, report, takeover, modelTurns: 0 }, null, 2),
  );
} finally {
  debug?.close();
  await f.cleanup();
}
