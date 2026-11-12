/** Real pinned daemon and owned Chrome; no model requests or personal browser data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { liveWeb, refOf, until, webFixture } from './web-fixture';

const options = { skip: !liveWeb, timeout: 60000 };
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const never = (page: number) => ({
  page,
  for: 'text',
  value: 'never-published-marker',
  timeout: 30000,
});

test(
  'task detail retains action arguments and page identity without persisting input values',
  options,
  async () => {
    const f = await webFixture('/plain');
    try {
      const task = await f.begin('audit-detail');
      const snapshot = await f.call('neo_snapshot', { page: task.page });
      const ref = refOf(snapshot.text, 'Title');
      await f.call('neo_act', {
        page: task.page,
        kind: 'fill',
        ref,
        value: 'never-store-this-input',
        credentials: 'never-store-extra-credentials',
      });
      let audit = await f.runtime.server.detail(task.sessionId);
      const action = audit.dispatches.find((x) => x.toolName === 'act')!;
      assert(action.argsJson, 'action arguments must be present');
      assert.deepEqual(JSON.parse(action.argsJson), {
        page: task.page,
        kind: 'fill',
        ref,
        value: '[hidden]',
      });
      assert.equal(action.targetId, f.browser.getState().activeTabId);
      assert.equal(action.title, 'Tasks');
      assert.equal(audit.session.site, new URL(f.origin).host);
      await f.call('neo_act', {
        page: task.page,
        kind: 'fill',
        fields: [{ ref, value: 'never-store-batch-input' }],
      });
      await f.call('neo_navigate', {
        page: task.page,
        url: f.origin + '/next?token=never-store-url-token#never-store-fragment',
      });
      const invalid = await f.runtime.callTool('neo_act', {
        page: task.page,
        kind: 'click',
        ref: 'never-log-invalid-ref',
      });
      assert(invalid.isError);
      audit = await f.runtime.server.detail(task.sessionId);
      const failure = audit.dispatches.filter((x) => x.toolName === 'act').at(-1)!;
      assert.equal(JSON.parse(failure.resultMeta!).isError, true);
      assert(JSON.parse(failure.resultMeta!).error);
      assert.equal(failure.targetId, action.targetId);
      assert.equal(failure.title, 'Tasks');
      const serialized = JSON.stringify(audit);
      for (const secret of [
        'never-store-this-input',
        'never-store-extra-credentials',
        'never-log-invalid-ref',
        'never-store-batch-input',
        'never-store-url-token',
        'never-store-fragment',
      ])
        assert(!serialized.includes(secret), secret);
      await f.runtime.finishTask('audit-detail', false);
      assert.equal((await f.runtime.server.detail(task.sessionId)).session.status, 'failed');
    } finally {
      await f.cleanup();
    }
  },
);

test('ending a recording does not wait for or cancel a read-only wait', options, async () => {
  const f = await webFixture('/plain');
  try {
    f.browser.startRecording();
    const task = await f.begin('recording-with-read');
    let completed = false;
    const pending = f.runtime.callTool('neo_wait', never(task.page)).then((result) => {
      completed = true;
      return result;
    });
    await until(() => task.worker.sockets.size, 'the wait to reach the daemon');
    const started = performance.now();
    const recording = await f.browser.stopRecording();
    assert(recording.endedAt);
    assert(performance.now() - started < 1000);
    assert.equal(completed, false, 'ending capture should not cancel the task');
    await f.runtime.cancelTask();
    assert((await pending).isError);
    await f.runtime.finishTask('recording-with-read');
  } finally {
    await f.cleanup();
  }
});

test(
  'clean completion reuses its daemon while task records, refs and authority stay separate',
  options,
  async (t) => {
    const f = await webFixture('/plain');
    try {
      const first = await f.begin('first');
      const firstTab = f.browser.getState().activeTabId!;
      const pid = first.worker.daemon.pid;
      assert(pid);
      await f.call('neo_snapshot', { page: first.page });
      await f.runtime.finishTask('first');
      const firstRecord = await f.runtime.server.detail(first.sessionId);
      assert.equal(firstRecord.session.status, 'done');
      assert(alive(pid));
      assert.equal(first.worker.sockets.size, 0, 'completed requests leave no open socket');
      await f.browser.newTab(f.origin + '/second');
      const second = await f.begin('second');
      assert.equal(second.worker.daemon.pid, pid, 'a completed task hands on its healthy daemon');
      assert(second.elapsed < 500, `reused task setup took ${second.elapsed} ms`);
      assert.notEqual(second.sessionId, first.sessionId);
      await first.client.cancel();
      await first.client.close(false);
      await assert.rejects(
        () => first.client.call('act', { page: first.page, kind: 'press', key: 'Enter' }),
        /已停止/,
      );
      assert(alive(pid), 'a finished task cannot stop the daemon it handed on');
      const snap = await f.call('neo_snapshot', { page: second.page });
      await f.call('neo_act', {
        page: second.page,
        kind: 'fill',
        ref: refOf(snap.text, 'Title'),
        value: '第二轮',
      });
      assert.equal(await f.state(`document.querySelector('#title').value`), '第二轮');
      const original = await f.browser.nativeEvaluate(
        firstTab,
        `document.querySelector('#title').value`,
        5000,
      );
      assert.equal(original.value, '');
      await f.runtime.finishTask('second');
      assert.deepEqual(await f.runtime.server.detail(first.sessionId), firstRecord);
      const readonly = await f.begin('readonly', true);
      assert.equal(readonly.worker.daemon.pid, pid);
      const refused = await f.runtime.callTool('neo_act', {
        page: readonly.page,
        kind: 'press',
        key: 'Enter',
      });
      assert(refused.isError);
      assert.match(refused.text, /只允许读取/);
      assert((await f.runtime.callTool('neo_tabs', { action: 'new' })).isError);
      await f.call('neo_tabs', { action: 'list' });
      await f.call('neo_read', { page: readonly.page, format: 'text' });
      await f.runtime.finishTask('readonly');
      assert.equal((await f.runtime.server.records()).length, 3);
      const directory = first.worker.directory;
      await access(directory);
      await f.runtime.stop();
      assert(!alive(pid));
      await assert.rejects(access(directory), /ENOENT/);
      t.diagnostic(
        `first setup ${first.elapsed}ms; reused setup ${second.elapsed}ms; same daemon PID ${pid}`,
      );
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'stopping ends in-flight and queued work, old refs die, and a takeover resumes on a fresh daemon',
  options,
  async (t) => {
    const f = await webFixture('/plain');
    const title = () => f.state(`document.querySelector('#title').value`);
    try {
      const primed = await f.begin('prime');
      const staleRef = refOf((await f.call('neo_snapshot', { page: primed.page })).text, 'Title');
      const initialPid = primed.worker.daemon.pid;
      await f.runtime.finishTask('prime');
      const cancel = await f.begin('cancel');
      assert.equal(cancel.worker.daemon.pid, initialPid);
      const snap = await f.call('neo_snapshot', { page: cancel.page });
      const pending = f.runtime.callTool('neo_wait', never(cancel.page));
      await until(() => cancel.worker.sockets.size, 'the wait to reach the daemon');
      const queued = f.runtime.callTool('neo_act', {
        page: cancel.page,
        kind: 'fill',
        ref: refOf(snap.text, 'Title'),
        value: 'must not execute',
      });
      const started = performance.now();
      await f.runtime.cancelTask();
      assert((await pending).isError);
      assert((await queued).isError);
      assert(!alive(initialPid));
      assert.equal(await title(), '');
      await f.runtime.finishTask('cancel');
      const cancelMs = Math.round(performance.now() - started);
      assert.equal((await f.runtime.server.detail(cancel.sessionId)).session.status, 'cancelled');
      const restarted = await f.begin('after-stop');
      const replacementPid = restarted.worker.daemon.pid;
      assert.notEqual(replacementPid, initialPid);
      await f.runtime.finishTask('after-stop');
      const takeover = await f.begin('takeover');
      assert.equal(takeover.worker.daemon.pid, replacementPid);
      const selected = (await f.browser.queryElements({ selector: '#title' })).elements[0];
      const observing = f.runtime.callTool('neo_wait', never(takeover.page));
      await until(() => takeover.worker.sockets.size, 'the wait to reach the daemon');
      const takeoverStart = performance.now();
      await f.browser.selectElement(selected.ref);
      assert((await observing).isError);
      assert(!alive(replacementPid));
      const takeoverMs = Math.round(performance.now() - takeoverStart);
      const blocked = await f.runtime.callTool('neo_act', {
        page: takeover.page,
        kind: 'press',
        key: 'Enter',
      });
      assert.match(blocked.text, /重新观察/);
      const resumeStart = performance.now();
      const fresh = await f.call('neo_snapshot', { page: takeover.page });
      const resumeMs = Math.round(performance.now() - resumeStart);
      const resumedClient = (f.runtime as any).current.client;
      const resumedPid = resumedClient.worker.daemon.pid;
      assert.notEqual(resumedPid, replacementPid);
      assert.notEqual(resumedClient.id, takeover.sessionId);
      const stale = await f.runtime.callTool('neo_act', {
        page: takeover.page,
        kind: 'fill',
        ref: staleRef,
        value: 'stale write',
      });
      assert(stale.isError);
      assert.match(stale.text, /引用已失效/);
      const barred = await f.runtime.callTool('neo_act', {
        page: takeover.page,
        kind: 'fill',
        ref: refOf(fresh.text, 'Title'),
        value: 'blocked write',
      });
      assert(barred.isError);
      assert.equal(await title(), '');
      await f.recover(takeover.page, 'Nothing saved');
      await f.runtime.finishTask('takeover');
      assert(!alive(resumedPid), 'a session with errors must not hand on its daemon');
      assert.equal((await f.runtime.server.detail(resumedClient.id)).session.status, 'done');
      const failed = await f.begin('model-failed');
      const failedPid = failed.worker.daemon.pid;
      await f.runtime.finishTask('model-failed', false);
      assert(!alive(failedPid));
      assert(cancelMs < 1000, `cancellation took ${cancelMs} ms`);
      assert(takeoverMs < 1000, `takeover took ${takeoverMs} ms`);
      assert(resumeMs < 1500, `the first step on a fresh daemon took ${resumeMs} ms`);
      t.diagnostic(`cancellation ${cancelMs}ms; takeover ${takeoverMs}ms; resume ${resumeMs}ms`);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'shutdown during startup leaves no daemon behind, and a browser restart rebinds',
  options,
  async () => {
    const f = await webFixture('/plain');
    const server = f.runtime.server as any;
    try {
      await f.runtime.stop();
      // The daemon for the first task is prepared in the background as soon as the executor is ready.
      await f.runtime.start();
      await until(() => server.worker, 'the background daemon to be created');
      const early = server.worker;
      await f.runtime.stop();
      assert(!early.alive);
      if (early.daemon?.pid) assert(!alive(early.daemon.pid));
      if (early.directory) await assert.rejects(access(early.directory), /ENOENT/);
      assert.equal(server.worker, undefined);

      await f.runtime.start();
      f.browser.allowAgentControl();
      const opening = f.runtime.beginTask('opening').then(
        () => undefined,
        (error) => error,
      );
      await f.runtime.stop();
      assert((await opening) instanceof Error, 'a task cannot begin on a stopped executor');
      assert.equal(server.sessions.size, 0);
      assert.equal(server.worker, undefined);
      assert.equal(f.runtime.getState().status, 'stopped');
      assert((await f.runtime.callTool('neo_snapshot', { page: 1 })).isError);

      await f.runtime.start();
      const fresh = await f.begin('after-shutdown');
      const attachedPid = fresh.worker.daemon.pid;
      await f.call('neo_snapshot', { page: fresh.page });
      await f.runtime.finishTask('after-shutdown');
      assert(alive(attachedPid));
      await f.browser.dispose();
      await f.browser.start(f.origin + '/restarted');
      await f.runtime.start();
      assert(!alive(attachedPid), 'a daemon bound to the old browser is not kept');
      const rebound = await f.begin('after-browser-restart');
      assert.notEqual(rebound.worker.daemon.pid, attachedPid);
      const snapshot = await f.call('neo_snapshot', { page: rebound.page });
      await f.call('neo_act', {
        page: rebound.page,
        kind: 'fill',
        ref: refOf(snapshot.text, 'Title'),
        value: 'after restart',
      });
      assert.equal(await f.state(`document.querySelector('#title').value`), 'after restart');
      await f.runtime.finishTask('after-browser-restart');
    } finally {
      await f.cleanup();
    }
  },
);

test('a daemon that dies between steps is replaced and its refs are refused', options, async () => {
  const f = await webFixture('/plain');
  try {
    const task = await f.begin('crash');
    const snapshot = await f.call('neo_snapshot', { page: task.page });
    const pid = task.worker.daemon.pid;
    process.kill(pid, 'SIGKILL');
    await until(() => !task.worker.alive, 'the daemon to exit');
    const stale = await f.runtime.callTool('neo_act', {
      page: task.page,
      kind: 'fill',
      ref: refOf(snapshot.text, 'Title'),
      value: 'lost',
    });
    assert(stale.isError);
    assert.match(stale.text, /引用已失效/);
    assert.equal(await f.state(`document.querySelector('#title').value`), '');
    await f.recover(task.page, 'Nothing saved');
    const again = await f.call('neo_snapshot', { page: task.page });
    assert.notEqual(task.client.worker.daemon.pid, pid);
    await f.call('neo_act', {
      page: task.page,
      kind: 'fill',
      ref: refOf(again.text, 'Title'),
      value: 'recovered',
    });
    assert.equal(await f.state(`document.querySelector('#title').value`), 'recovered');
    assert.equal(f.runtime.getState().status, 'ready');
    await f.runtime.finishTask('crash');
  } finally {
    await f.cleanup();
  }
});

test(
  'human help hands the page over, reports its status and requires a fresh look',
  options,
  async () => {
    const f = await webFixture('/plain');
    try {
      const task = await f.begin('help');
      assert.match((await f.call('neo_await_human_help', {})).text, /没有人工协助请求/);
      const help = await f.call('neo_request_human_help', {
        page: task.page,
        reason: 'Sign in for me',
        kind: 'login',
      });
      assert.match(help.text, /交回控制权/);
      assert.equal(f.approvals.at(-1)!.action, 'browser-help');
      assert.match(f.approvals.at(-1)!.detail, /Sign in for me/);
      assert.match((await f.call('neo_await_human_help', {})).text, /"status":"resolved"/);
      const early = await f.runtime.callTool('neo_act', {
        page: task.page,
        kind: 'press',
        key: 'Tab',
      });
      assert(early.isError, 'the page the human touched must be read again first');
      await f.recover(task.page, 'Nothing saved');
      await f.call('neo_act', { page: task.page, kind: 'press', key: 'Tab' });
      await f.runtime.finishTask('help');
    } finally {
      await f.cleanup();
    }
  },
);
