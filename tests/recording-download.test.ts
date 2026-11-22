import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { BrowserRuntime } from '../src/main/browser';
import type { CdpConnection } from '../src/main/browser-cdp';
import { verifyCustomerMaterials } from '../src/main/recording-verification';
import type { RecordedStep } from '../src/shared/types';

const options = { customerId: 'C1008', excludeInternal: true };
async function materials(dir: string, note = '') {
  const names = ['customer.json', '营业资质.md', '服务协议.md', '结算说明.md'];
  for (const name of names) {
    await writeFile(
      path.join(dir, name),
      name === 'customer.json' ? JSON.stringify({ id: 'C1008' }) : '客户：C1008 测试\n' + note,
    );
  }
  const file = path.join(dir, 'materials.zip');
  await promisify(execFile)('/usr/bin/zip', ['-q', '-X', '-j', file, ...names], { cwd: dir });
  return file;
}

test(
  'validates a selected customer archive against its content and explicit exclusion rule',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'athena-check-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = await materials(dir);
    assert.equal((await verifyCustomerMaterials(file, options)).status, 'passed');
    assert.equal(
      (await verifyCustomerMaterials(file, { ...options, customerId: 'C1001' })).status,
      'failed',
    );
    await rm(file);
    await materials(dir, 'INTERNAL_ONLY');
    assert.equal((await verifyCustomerMaterials(file, options)).status, 'failed');
    assert.equal(
      (await verifyCustomerMaterials(file, { ...options, excludeInternal: false })).status,
      'passed',
    );
    await rm(file);
    assert.equal((await verifyCustomerMaterials(file, options)).status, 'unknown');
  },
);

test(
  'Chrome attributes direct and asynchronous downloads, keeps unrelated recordings out of a trial',
  {
    skip: !process.env.ATHENA_TEST_CHROME || process.platform !== 'darwin',
    timeout: 45000,
  },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'athena-dl-'));
    const fixture = path.join(dir, 'fixture');
    await mkdir(fixture);
    const bytes = await readFile(await materials(fixture));
    const site = createServer((req, res) => {
      if (req.url === '/slow.zip') {
        res.writeHead(200, {
          'content-disposition': 'attachment; filename="pending.zip"',
          'content-length': bytes.length,
        });
        res.write(bytes.subarray(0, 8));
      } else if (req.url?.startsWith('/file.zip')) {
        res.writeHead(200, {
          'content-disposition': 'attachment; filename="evidence.zip"',
          'content-type': 'application/zip',
        });
        res.end(bytes);
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><title>Materials</title><table><tr><td><strong>客户</strong><small>C1008</small></td><td data-private>HIDDEN-DATA</td><td>
        <a href="/file.zip?token=local-secret" id="link" download>下载</a>
        <button id="export" onclick="save()">导出材料</button><button id="two" onclick="save();save()">两个文件</button>
        <input id="remarks" type="checkbox" checked aria-label="内部备注"><input type="checkbox" id="private" data-private>
        <select id="choice"><option>默认</option></select><button id="synthetic" onclick="
          document.querySelector('#choice').dispatchEvent(new Event('change',{bubbles:true}));
          this.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));">触发网页事件</button>
        <a id="slow" download href="/slow.zip">等候下载</a>
        <div role="status">原有状态</div><div id="warn" role="alert"></div>
        <form><input required aria-label="缺少资料"><button id="submit">检查表单</button></form>
        <button id="error" onclick="document.querySelector('#warn').innerHTML='保存失败 Bearer xyz <i data-private>secret area</i> test@example.com'">保存</button>
        <button id="late" onclick="setTimeout(()=>{document.querySelector('#warn').textContent='延迟消息';save()},1200)">慢操作</button>
        </td></tr></table><script>async function save(){const b=await(await fetch('/file.zip')).blob();
        const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='async.zip';
        document.body.appendChild(a);a.click();a.remove();}</script>`);
      }
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + (site.address() as any).port;
    const sent: RecordedStep[] = [];
    const browser = new BrowserRuntime({
      storageDir: path.join(dir, 'profile'),
      binaryPath: process.env.ATHENA_TEST_CHROME,
      onState() {},
      onStep: (s) => sent.push(s),
      onFrame() {},
      onSelected() {},
      onHumanTakeover() {},
    });
    try {
      await browser.start(origin);
      const tabId = browser.getState().activeTabId!;
      const scope = { tabId, origin };
      const click = async (selector: string) => {
        const { elements } = await browser.queryElements({ selector });
        const rect = elements[0].bounds!;
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        await browser.dispatchInput({ type: 'mouse', action: 'down', button: 'left', ...point });
        await browser.dispatchInput({ type: 'mouse', action: 'up', button: 'left', ...point });
      };
      browser.startRecording();
      await click('#error');
      const alerts = await browser.stopRecording();
      const feedback = alerts.steps.filter((s) => s.kind === 'feedback');
      assert.equal(feedback.length, 1);
      assert.equal(feedback[0].source, 'page');
      assert.equal(feedback[0].feedback?.role, 'alert');
      assert.match(feedback[0].feedback!.text, /保存失败/);
      assert.doesNotMatch(JSON.stringify(feedback), /原有状态|Bearer xyz|secret area|test@example/);
      browser.startRecording();
      await click('#submit');
      const invalid = await browser.stopRecording();
      const validation = invalid.steps.find((s) => s.kind === 'feedback');
      assert.equal(validation?.feedback?.role, 'alert');
      assert.ok(validation?.feedback?.text);
      assert.doesNotMatch(validation.feedback.text, /保存失败|原有状态/);
      browser.startRecording();
      await click('#late');
      await browser.stopRecording();
      browser.startRecording(undefined, undefined, scope);
      await new Promise((resolve) => setTimeout(resolve, 1250));
      const next = await browser.stopRecording();
      assert.ok(
        next.steps.every((s) => s.kind !== 'feedback'),
        'an earlier observation window must not enter the next recording',
      );
      assert.equal(
        (await browser.verifyRecordedDownload(next, { ...scope, ...options })).status,
        'unknown',
        'a delayed file from an earlier recording must not pass the next trial',
      );
      browser.startRecording();
      const mark = browser.nativeDownloadMark();
      await click('#synthetic');
      await click('#remarks');
      await click('#private');
      await click('#link');
      await browser.nativeAwaitDownload(mark);
      const direct = await browser.stopRecording();
      assert.ok(
        direct.steps.every((step) => step.kind !== 'select' && step.kind !== 'key'),
        'page-generated select/key events must not be attributed to a person',
      );
      const directClick = direct.steps.find(
        (s) => s.kind === 'click' && s.target?.name === '下载',
      )!;
      assert.equal(
        direct.steps.find((s) => s.kind === 'fill' && s.target?.name === '内部备注')?.checked,
        false,
      );
      assert.equal(
        direct.steps.find((s) => s.kind === 'fill' && s.target?.name === '[hidden]')?.checked,
        undefined,
      );
      assert.equal(directClick.scopeText, '客户 C1008');
      assert.deepEqual(directClick.outcome, {
        kind: 'download',
        origin: 'link',
        status: 'completed',
      });
      assert.ok(!JSON.stringify(direct).includes('local-secret'));
      assert.ok(!JSON.stringify(direct).includes('HIDDEN-DATA'));

      sent.length = 0;
      browser.startRecording(undefined, undefined, scope);
      await click('#export');
      const trial = await browser.stopRecording();
      assert.deepEqual(sent, []);
      assert.equal(trial.steps.find((s) => s.kind === 'click')?.outcome, undefined);
      assert.deepEqual(trial.steps.find((s) => s.kind === 'download')?.outcome, {
        kind: 'download',
        origin: 'page',
        status: 'completed',
      });
      assert.equal(
        (await browser.verifyRecordedDownload(trial, { ...options, ...scope })).status,
        'passed',
      );
      assert.equal(
        (await browser.verifyRecordedDownload(trial, { ...options, ...scope, customerId: 'C1001' }))
          .status,
        'failed',
      );
      assert.equal(
        (await browser.verifyRecordedDownload(trial, { ...options, ...scope, tabId: 'other' }))
          .status,
        'unknown',
      );

      browser.startRecording(undefined, undefined, scope);
      await click('#two');
      await new Promise((resolve) => setTimeout(resolve, 350));
      const many = await browser.stopRecording();
      assert.equal(
        (await browser.verifyRecordedDownload(many, { ...options, ...scope })).status,
        'unknown',
      );
      assert.equal(
        (
          await browser.verifyRecordedDownload(
            { ...trial, id: 'another' },
            { ...options, ...scope },
          )
        ).status,
        'unknown',
      );
      browser.startRecording(undefined, undefined, scope);
      const cdp = (browser as unknown as { browser: CdpConnection }).browser;
      const starting = new Promise<string>((resolve) =>
        cdp.on('Browser.downloadWillBegin', (p) => resolve(p.guid)),
      );
      await click('#slow');
      const guid = await starting;
      await cdp.call('Browser.cancelDownload', { guid });
      const canceled = await browser.stopRecording();
      assert.equal(canceled.steps.find((s) => s.outcome)?.outcome?.status, 'canceled');
      assert.equal(
        (await browser.verifyRecordedDownload(canceled, { ...options, ...scope })).status,
        'failed',
      );
      browser.startRecording(undefined, undefined, scope);
      await browser.newTab(origin + '/other');
      const otherMark = browser.nativeDownloadMark();
      await click('#link');
      await browser.nativeAwaitDownload(otherMark);
      await browser.switchTab(tabId);
      const scoped = await browser.stopRecording();
      assert.ok(scoped.steps.every((step) => step.tabId === tabId && !step.outcome));
      assert.equal(
        (await browser.verifyRecordedDownload(scoped, { ...options, ...scope })).status,
        'unknown',
      );
      // Losing the frame during a transient trial must leave the recorder available.
      const frame = (browser as unknown as { tabs: Map<string, { page: CdpConnection }> }).tabs.get(
        tabId,
      )!.page;
      const original = frame.call;
      const call: CdpConnection['call'] = original.bind(frame);
      browser.startRecording(undefined, undefined, scope);
      assert.equal(browser.getRecording(), undefined);
      frame.call = function <T>(
        method: string,
        params?: Record<string, unknown>,
        timeout?: number,
      ): Promise<T> {
        if (
          method === 'Runtime.evaluate' &&
          params?.expression === 'globalThis.__workbenchPage?.flushFeedback()'
        )
          return Promise.reject(new Error('Frame disappeared'));
        return call<T>(method, params, timeout);
      };
      try {
        assert.equal((await browser.stopRecording()).truncated, true);
      } finally {
        frame.call = original;
      }
      assert.equal(browser.getState().recording, false);
      browser.startRecording();
      assert.ok(browser.getRecording());
      await browser.stopRecording();
    } finally {
      await browser.dispose();
      site.closeAllConnections();
      await new Promise<void>((resolve) => site.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
