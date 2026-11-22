/** --prepare records a local example. --fixture DIR tests a copied profile with a fixed draft.
 * --analyze DIR makes one real Codex turn. --resume DIR retries practice with the saved draft.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { _electron as electron, expect } from '@playwright/test';
import { CdpConnection } from '../src/main/browser-cdp';
import type { AppSnapshot, Recording } from '../src/shared/types';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';

const mode = process.argv[2];
if (!['--prepare', '--fixture', '--analyze', '--resume'].includes(mode))
  throw Error('Choose --prepare, --fixture DIR, --analyze DIR, or --resume DIR.');
const prepare = mode === '--prepare';
const dir = prepare
  ? await mkdtemp(path.join(tmpdir(), 'athena-recording-live-'))
  : path.resolve(process.argv[3]);
const metadata = path.join(dir, 'scenario.json');
let origin = prepare ? '' : (JSON.parse(await readFile(metadata, 'utf8')).origin as string);
const profile = path.join(dir, 'profile');
if (prepare) {
  await mkdir(profile);
  await seedLegacyWorkspace(profile);
}
let dataDir = profile;
if (mode === '--fixture') {
  dataDir = await mkdtemp(path.join(dir, 'fixture-'));
  const saved = JSON.parse(await readFile(path.join(profile, 'workspace.json'), 'utf8'));
  const rec: Recording = saved.recordings[0];
  const steps = rec.steps.filter((e) => e.target && e.source === 'human');
  assert(steps.length);
  rec.workflow = {
    revision: 'fixture',
    goal: '导出客户材料',
    steps: steps.map((e) => ({ note: e.description, stepIds: [e.id] })),
    questions: [{ question: '内部备注的排除范围？', stepIds: [steps[0].id] }],
  };
  await writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify(saved), { mode: 0o600 });
}
const downloads: string[] = [];
const packets = new Map<string, Buffer>();
for (const id of ['C1001', 'C1008'])
  for (const scope of ['public', 'internal']) {
    const bytes = execFileSync('python3', [
      '-c',
      `import io,json,sys,zipfile
id,scope=sys.argv[1:]
buf=io.BytesIO()
with zipfile.ZipFile(buf,'w') as z:
 z.writestr('customer.json',json.dumps(dict(id=id)))
 for n in ('营业资质.md','服务协议.md','结算说明.md'): z.writestr(n,'客户：'+id+' 演示资料\\n'+('INTERNAL_ONLY' if scope=='internal' else ''))
sys.stdout.buffer.write(buf.getvalue())`,
      id,
      scope,
    ]);
    packets.set('/' + id + '/' + scope + '.zip', bytes);
  }
const site = createServer((req, res) => {
  const route = req.url ?? '/';
  const payload = packets.get(route);
  if (payload) {
    downloads.push(route);
    res.writeHead(200, {
      'content-disposition': 'attachment; filename="materials.zip"',
      'content-type': 'application/zip',
      'content-length': payload.length,
    });
    res.end(payload);
    return;
  }
  if (route !== '/') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
  res.end(
    `<!doctype html><meta charset=utf-8><title>客户资料</title><style>body{padding:24px;font:16px system-ui}td,th{padding:20px}input{width:22px;height:22px}a{padding:8px;display:inline-block}</style><h1>对外导出客户材料</h1><table><tr><th>客户编号</th><th>包含内部备注</th><th>客户材料</th></tr>${['C1001', 'C1008'].map((id) => `<tr><td>${id}</td><td><input type="checkbox" checked id="note-${id}" aria-label="包含内部备注" onchange="this.closest('tr').querySelector('a').href='/${id}/'+(this.checked?'internal':'public')+'.zip'"></td><td><a id="export-${id}" href="/${id}/internal.zip" download>导出客户材料</a></td></tr>`).join('')}</table>`,
  );
});
await new Promise<void>((ok, fail) => {
  site.once('error', fail);
  site.listen(prepare ? 0 : Number(new URL(origin).port), '127.0.0.1', ok);
});
origin = 'http://127.0.0.1:' + (site.address() as { port: number }).port;
console.log(JSON.stringify({ mode, dir }));
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
let chrome: CdpConnection | undefined;
try {
  const quiet = path.join(dir, 'hidden.cjs');
  await writeFile(
    quiet,
    "const {BrowserWindow}=require('electron');BrowserWindow.prototype.show=function(){this.webContents.setBackgroundThrottling(false);this.hide()};BrowserWindow.prototype.focus=function(){}",
  );
  const env = { ...process.env, WORKBENCH_USER_DATA_DIR: dataDir };
  delete (env as NodeJS.ProcessEnv).WORKBENCH_DEV_SERVER_URL;
  app = await electron.launch({ args: ['-r', quiet, '.'], env, cwd: process.cwd() });
  const page = await app.firstWindow();
  const invoke = <T = unknown>(action: string, payload?: unknown) =>
    page.evaluate(({ action, payload }) => window.workbench.invoke<T>(action, payload), {
      action,
      payload,
    });
  const snapshot = () => invoke<AppSnapshot>('app:snapshot');
  await page.waitForFunction(() => !!window.workbench);
  await invoke('browser:start');
  await invoke('browser:navigate', { url: origin + '/' });
  await invoke('browser:resize', { width: 960, height: 720, pixelRatio: 1, fitToWidth: false });
  const [port] = (
    await readFile(path.join(dataDir, 'browser/agent-browser-profile/DevToolsActivePort'), 'utf8')
  ).split('\n');
  const targets = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()) as {
    url: string;
    webSocketDebuggerUrl: string;
  }[];
  chrome = await CdpConnection.connect(
    targets.find((t) => t.url === origin + '/')!.webSocketDebuggerUrl,
  );
  const centre = async (selector: string) =>
    (
      await chrome!.call('Runtime.evaluate', {
        expression: `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        returnByValue: true,
      })
    ).result.value as Point;
  const click = async (p: Point) => {
    for (const action of ['down', 'up'])
      await invoke('browser:input', { type: 'mouse', button: 'left', action, ...p });
  };
  let recording: Recording;
  if (prepare) {
    await invoke('recording:start');
    await click(await centre('#note-C1001'));
    await click(await centre('#export-C1001'));
    await expect.poll(() => downloads.includes('/C1001/public.zip')).toBeTruthy();
    await expect.poll(async () => (await snapshot()).browser.recording).toBe(true);
    await wait(300);
    recording = await invoke<Recording>('recording:stop');
    assert(recording.steps.some((e) => e.scopeText === 'C1001' && e.checked === false));
    assert(recording.steps.some((e) => e.outcome?.status === 'completed'));
    await writeFile(metadata, JSON.stringify({ origin, id: recording.id }), {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(JSON.stringify({ recordedSteps: recording.steps.length, downloads }));
  } else {
    const id = JSON.parse(await readFile(metadata, 'utf8')).id;
    const readRecording = async () => (await snapshot()).recordings.find((r) => r.id === id)!;
    recording = await readRecording();
    if (mode === '--analyze') {
      assert.equal(
        process.env.ATHENA_TEST_RECORDING_LIVE,
        '1',
        'Set ATHENA_TEST_RECORDING_LIVE=1 to authorize one real model call.',
      );
      assert(!recording.workflow, 'Resume this existing draft instead.');
      const status = await snapshot();
      assert(
        status.agents.some((a) => a.id === 'codex' && a.available),
        'Codex CLI must be available.',
      );
      await writeFile(path.join(dir, 'model-requested'), '1', { flag: 'wx', mode: 0o600 });
      const { conversationId } = await invoke<{ conversationId: string }>('recording:analyze', {
        id,
      });
      console.log(JSON.stringify({ realModel: 'requested', conversationId }));
      await expect
        .poll(
          async () => {
            const s = await snapshot();
            const msg = s.conversations
              .find((c) => c.id === conversationId)
              ?.messages.filter((m) => m.role === 'assistant')
              .at(-1);
            return !!s.recordings.find((r) => r.id === id)?.workflow || msg?.status === 'error';
          },
          { timeout: 15 * 60_000 },
        )
        .toBe(true);
      recording = await readRecording();
      const assistant = (await snapshot()).conversations
        .find((c) => c.id === conversationId)
        ?.messages.filter((m) => m.role === 'assistant')
        .at(-1);
      assert(
        recording.workflow,
        `Real analysis ended without a validated draft (status ${assistant?.status}).`,
      );
      console.log(
        JSON.stringify({
          actualModel: assistant?.model,
          steps: recording.workflow.steps.length,
          questions: recording.workflow.questions.length,
        }),
      );
    }
    const wf = recording.workflow;
    assert(wf, 'A persisted and validated recording draft is required.');
    assert(wf.questions.length > 0, 'This demonstration did not generate a rule clarification.');
    for (const question of wf.questions) {
      const input = { id, revision: wf.revision, question: question.question };
      const preliminary = '本次先按录制示例操作。';
      await invoke('recording:answer', {
        ...input,
        answer: preliminary,
        previousAnswer: question.answer,
      });
      await invoke('recording:answer', {
        ...input,
        answer: '本次用于对外导出，仅导出指定客户的公开材料，排除内部备注。',
        previousAnswer: preliminary,
      });
    }
    await invoke('recording:practice', {
      id,
      revision: wf.revision,
      example: 'C1001',
      target: 'C1008',
      verifyCustomerZip: true,
      excludeInternal: true,
      rulesReviewed: true,
    });
    const bCheck = await centre('#note-C1008'),
      bExport = await centre('#export-C1008');
    let last = '',
      handledCheck = false,
      handledExport = false;
    const deadline = Date.now() + 45000;
    for (;;) {
      const p = (await readRecording()).practice;
      if (p && p.status !== 'guiding') break;
      assert(
        Date.now() < deadline,
        'Timed out waiting for the next bound guide step: ' + JSON.stringify(p),
      );
      const overlay = await readOverlay(chrome!);
      if (!overlay || overlay.id === last) {
        await wait(70);
        continue;
      }
      await wait(400);
      const shown = await readOverlay(chrome!);
      if (!shown || shown.id !== overlay.id) continue;
      last = shown.id;
      if (shown.ring) {
        const near = (p: Point) => Math.hypot(shown.ring!.x - p.x, shown.ring!.y - p.y) < 12;
        assert(
          near(bCheck) || near(bExport),
          'Guide did not point at the intended customer row: ' + JSON.stringify(shown),
        );
        if (near(bCheck) && !handledCheck) {
          await click(bCheck);
          handledCheck = true;
        }
        if (near(bExport) && !handledExport) {
          await click(bExport);
          handledExport = true;
        }
      }
      if (shown.action === 'look') await click(shown.next);
      console.log(JSON.stringify({ guide: shown.id, action: shown.action, located: !!shown.ring }));
    }
    const practice = (await readRecording()).practice;
    assert.equal(practice?.status, 'finished', JSON.stringify(practice));
    assert.equal(practice.verification, 'passed', JSON.stringify(practice));
    assert(handledCheck && handledExport);
    assert.deepEqual(downloads, ['/C1008/public.zip']);
    const messages = (await snapshot()).conversations
      .flatMap((c) => c.messages)
      .filter((m) => m.role === 'assistant' && m.status === 'done');
    const realModel = mode !== '--fixture';
    if (realModel) {
      assert.equal(await readFile(path.join(dir, 'model-requested'), 'utf8'), '1');
      assert.equal(messages.length, 1, 'Only one model turn should have been used');
      assert(messages[0].model?.model);
    }
    const assistant = realModel ? messages[0] : undefined;
    const evidence = {
      passed: true,
      recordedSteps: recording.steps.length,
      modelTurns: realModel ? 1 : 0,
      model: assistant?.model,
      modelElapsedMs: assistant?.endedAt ? assistant.endedAt - assistant.createdAt : undefined,
      modelToolCalls: assistant?.tools?.length ?? 0,
      draft: {
        goal: wf.goal,
        steps: wf.steps,
        parameters: wf.parameters,
        questions: wf.questions.map(({ question, stepIds }) => ({ question, stepIds })),
      },
      userConfirmed: (await readRecording()).workflow?.questions.map((q) => q.answer),
      input: 'automated test through the human browser:input channel',
      download: downloads[0],
      practice,
    };
    const results = path.resolve('test-results/recording-practice-live');
    await mkdir(results, { recursive: true });
    const report = path.join(results, (realModel ? 'model-' : 'fixture-') + id + '.json');
    await writeFile(report, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ mode, report, passed: true, download: downloads[0], practice }));
  }
} finally {
  chrome?.close();
  await app?.close();
  site.close();
}
type Point = { x: number; y: number };
async function readOverlay(chrome: CdpConnection) {
  const { root } = await chrome.call('DOM.getDocument', { depth: -1, pierce: true });
  const nodes = new Map<string, any>();
  function walk(n: any) {
    const a: string[] = n.attributes ?? [],
      c = a[a.indexOf('class') + 1];
    if (c && /(?:^| )gd(?:$| |-)/.test(c) && a.includes('class')) {
      if (c.split(' ').includes('gd')) nodes.set('layer', n);
      else nodes.set(c, n);
    }
    if (a.includes('data-do') && a[a.indexOf('data-do') + 1] === 'next') nodes.set('next', n);
    for (const child of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(child);
  }
  walk(root);
  const layer = nodes.get('layer');
  if (!layer || layer.attributes.includes('data-bye') || layer.attributes.includes('data-busy'))
    return;
  const attr = (name: string) => layer.attributes[layer.attributes.indexOf(name) + 1];
  const center = async (n: any) => {
    const { model } = await chrome.call('DOM.getBoxModel', { nodeId: n.nodeId });
    return {
      x: (model.border[0] + model.border[4]) / 2,
      y: (model.border[1] + model.border[5]) / 2,
    };
  };
  return {
    id: nodes.get('gd-count').children?.[0]?.nodeValue || '1 / 1',
    action: attr('data-action'),
    ring: attr('data-at') === 'target' ? await center(nodes.get('gd-ring')) : undefined,
    next: await center(nodes.get('next')),
  };
}
