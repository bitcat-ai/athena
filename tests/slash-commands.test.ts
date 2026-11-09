import assert from 'node:assert/strict';
import test from 'node:test';
import type { SlashCommandList } from '../src/shared/types';
import { PiSession } from '../src/main/pi-session';

test('Pi discovers native slash commands from the RPC command catalog', async () => {
  const session = Object.create(PiSession.prototype) as PiSession;
  (session as any).prepare = async () => {};
  (session as any).request = async (type: string) => {
    assert.equal(type, 'get_commands');
    return {
      commands: [
        { name: 'compact', description: 'Compact the conversation', source: 'extension' },
        { name: 'review', source: 'skill' },
        { name: '/bad', source: 'prompt' },
      ],
    };
  };
  const result = await session.listCommands();
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.commands, [
    { name: '/compact', description: '压缩当前会话（会调用模型）' },
    { name: '/name', description: '设置 Pi 会话名称' },
    { name: '/session', description: '查看 Pi 会话统计' },
    { name: '/review', description: '' },
  ]);
});

test('Pi exposes Athena native RPC commands even when the extension catalog is empty', async () => {
  const session = Object.create(PiSession.prototype) as PiSession;
  (session as any).prepare = async () => {};
  (session as any).request = async () => ({ commands: [] });
  const result = await session.listCommands();
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.commands, [
    { name: '/compact', description: '压缩当前会话（会调用模型）' },
    { name: '/name', description: '设置 Pi 会话名称' },
    { name: '/session', description: '查看 Pi 会话统计' },
  ]);
});

test('Pi command discovery reports unsupported responses without fake commands', async () => {
  const session = Object.create(PiSession.prototype) as PiSession;
  (session as any).prepare = async () => {};
  (session as any).request = async () => {
    throw new Error('unsupported');
  };
  const result = await session.listCommands();
  assert.equal(result.status, 'unsupported');
  assert.deepEqual(result.commands, []);
});

test('Pi maps built-in RPC commands to user-visible native commands', async () => {
  const session = Object.create(PiSession.prototype) as PiSession;
  (session as any).prepare = async () => {};
  (session as any).request = async () => ({
    commands: [
      { name: 'compact', description: 'Compact the conversation', source: 'builtin' },
      { name: 'review', description: 'Inspect changes', source: 'extension' },
    ],
  });
  const result = await session.listCommands();
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.commands, [
    { name: '/compact', description: '压缩当前会话（会调用模型）' },
    { name: '/name', description: '设置 Pi 会话名称' },
    { name: '/session', description: '查看 Pi 会话统计' },
    { name: '/review', description: 'Inspect changes' },
  ]);
});

test('Pi 原生命令保留斜杠和参数', async () => {
  const session = Object.create(PiSession.prototype) as PiSession;
  (session as any).prepare = async () => {};
  (session as any).listCommands = async () => ({
    status: 'ready',
    commands: [{ name: '/skill:review', description: '' }],
  });
  (session as any).request = async () => ({ isStreaming: false, pendingMessageCount: 0 });
  let submitted = '';
  (session as any).send = async (value: string) => {
    submitted = value;
  };
  await session.executeCommand('/skill:review', '检查当前修改');
  assert.equal(submitted, '/skill:review 检查当前修改');
});

test('unsupported command discovery has a stable empty result', () => {
  const result: SlashCommandList = {
    status: 'unsupported',
    commands: [],
    reason: 'CLI does not expose command discovery',
  };
  assert.deepEqual(result.commands, []);
  assert.equal(result.status, 'unsupported');
});
