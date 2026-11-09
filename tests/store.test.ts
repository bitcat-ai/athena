import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/main/store';

test('workspace persists and interrupted responses do not look live after restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-store-'));
  try {
    const first = new Store(directory);
    await first.load();
    first.data.conversations.push({
      id: 'one',
      title: '工作',
      updatedAt: 1,
      messages: [
        {
          id: 'message',
          role: 'assistant',
          text: '尚未完成',
          createdAt: 1,
          status: 'streaming',
          plan: [{ step: '核对回执', status: 'inProgress' }],
          tools: [{ id: 'submit', name: 'neo_act', input: {}, status: 'running', startedAt: 1 }],
          execution: [{ id: 'op', taskId: 'message', at: 1, kind: 'operation', status: 'running' }],
        },
      ],
    });
    await first.save();
    const second = new Store(directory);
    await second.load();
    assert.equal(second.data.conversations[0].messages[0].status, 'error');
    assert.equal(second.data.conversations[0].messages[0].text, '尚未完成');
    const message = second.data.conversations[0].messages[0];
    assert.equal(message.tools?.[0].status, 'error');
    assert.match(message.tools?.[0].output ?? '', /结果未知/);
    assert.equal(
      message.tools?.[0].durationMs,
      undefined,
      'Unknown execution duration is not invented',
    );
    assert.equal(message.execution?.at(-1)?.kind, 'finished');
    assert.equal(message.execution?.at(-1)?.status, 'failed');
    assert.equal(message.plan?.[0].step, '核对回执');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('conversation archive timestamp persists through workspace reload', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-store-'));
  try {
    const first = new Store(directory);
    await first.load();
    first.data.conversations.push({
      id: 'archived',
      title: '归档',
      updatedAt: 1,
      archivedAt: 42,
      messages: [],
    });
    await first.save();
    const second = new Store(directory);
    await second.load();
    assert.equal(second.data.conversations[0].archivedAt, 42);
    delete second.data.conversations[0].archivedAt;
    await second.save();
    const third = new Store(directory);
    await third.load();
    assert.equal(third.data.conversations[0].archivedAt, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupt data is preserved instead of being silently overwritten', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-store-'));
  try {
    const file = path.join(directory, 'workspace.json');
    await writeFile(file, '{invalid');
    await assert.rejects(() => new Store(directory).load());
    assert.equal(await readFile(file, 'utf8'), '{invalid');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
