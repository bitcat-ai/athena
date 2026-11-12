import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { SandboxPip } from '../src/main/sandbox-pip';
import type { SandboxPipState } from '../src/shared/sandbox';

test('closing one sandbox preserves the other and dismissal lasts only one turn', async () => {
  let states: SandboxPipState[] = [];
  const pip = new SandboxPip({
    state: ({ target }) => ({
      target,
      running: false,
      lines: [],
      status: { text: '已连接', tone: 'ok' },
    }),
    publish: (next) => {
      states = next;
    },
    onVisible: () => {},
  });
  const frontend = { conversationId: 'task', target: 'frontend' } as const;
  const backend = { conversationId: 'task', target: 'backend' } as const;
  pip.autoOpen(frontend);
  pip.autoOpen(backend);
  await setTimeout(100);
  assert.deepEqual(
    states.map((state) => state.target),
    ['frontend', 'backend'],
  );
  pip.dismiss(frontend);
  pip.autoOpen(frontend);
  await setTimeout(100);
  assert.deepEqual(
    states.map((state) => state.target),
    ['backend'],
  );
  pip.resetDismissal('task');
  pip.autoOpen(frontend);
  await setTimeout(100);
  assert.equal(states.length, 2);
  pip.hide();
  assert.deepEqual(states, []);
});
