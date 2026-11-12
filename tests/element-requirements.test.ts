import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  recordRequirementPreview,
  assertRequirementRecorded,
  saveElementRequirement,
  continueElementRequirement,
  type ElementRequirement,
} from '../src/main/element-requirements';
import type { ElementDetails } from '../src/shared/types';

test('a preview survives a later conversational confirmation without switching its target', () => {
  const element = { ref: 'picked', tag: 'button', name: '查看资料', documentId: 'd' };
  const first = continueElementRequirement(
    undefined,
    {
      conversationId: 'c',
      turnId: 't1',
      userRequest: '旁边添加导出按钮，先预览',
      url: 'http://localhost',
    },
    element,
  )!;
  first.preview = {
    editId: 'edit',
    at: 1,
    changes: {},
    element: {
      ...element,
      ref: 'inserted',
      textContent: '导出材料',
      editableText: true,
      attributes: {},
      computed: {},
      ancestors: [],
      shadowPath: [],
    },
  };
  const second = continueElementRequirement(first, {
    conversationId: 'c',
    turnId: 't2',
    userRequest: '外观可以，排除内部备注，记录PRD',
    url: 'http://localhost',
  })!;
  assert.equal(second.preview?.editId, 'edit');
  assert.equal(second.turnId, 't2');
  assert.equal(second.selected.ref, 'picked');
  assert.match(second.userRequest, /先预览/);
  assert.match(second.userRequest, /排除内部备注/);
  assert.throws(() => assertRequirementRecorded(second), /先调用/);
  const other = continueElementRequirement(
    second,
    { conversationId: 'c', turnId: 't3', userRequest: '调整另一个按钮', url: 'http://localhost' },
    { ...element, ref: 'other' },
  )!;
  assert.equal(other.preview, undefined);
  assert.equal(other.selected.ref, 'other');
});

test('PRD requires a real matching preview, preserves user intent and unlocks source work only after a verified save', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'athena-prd-'));
  const selected = {
    ref: 'selected',
    tag: 'button',
    name: '查看资料',
    documentId: 'doc',
    nodeId: 'anchor',
  };
  const r: ElementRequirement = {
    conversationId: 'conversation',
    turnId: 'turn',
    url: 'http://localhost/customers',
    userRequest: '在这个按钮旁边添加导出材料，排除内部跟进',
    selected,
  };
  const element: ElementDetails = {
    ref: 'inserted',
    tag: 'button',
    name: '导出材料',
    documentId: 'doc',
    nodeId: 'new-button',
    textContent: '导出材料',
    editableText: true,
    attributes: {},
    computed: {},
    ancestors: [],
    shadowPath: [],
  };
  const args = {
    title: '客户材料导出',
    requirements: ['增加逐行导出按钮'],
    acceptance: ['ZIP 不含内部跟进和其他客户资料'],
  };
  const signal = new AbortController().signal;
  try {
    await assert.rejects(
      saveElementRequirement(dir, r, args, async () => element, signal),
      /尚无/,
    );
    const result = { text: JSON.stringify({ editId: 'preview-1', element }) };
    recordRequirementPreview(r, { ref: 'other' }, result);
    assert.equal(r.preview, undefined);
    recordRequirementPreview(r, { ref: 'selected' }, { ...result, isError: true });
    assert.equal(r.preview, undefined);
    recordRequirementPreview(
      r,
      { ref: 'selected', insert: { position: 'after', node: { tag: 'button', text: '导出材料' } } },
      result,
    );
    assert.throws(() => assertRequirementRecorded(r), /先调用/);
    await assert.rejects(
      saveElementRequirement(
        dir,
        r,
        args,
        async () => ({ ...element, documentId: 'navigated' }),
        signal,
      ),
      /已变化/,
    );
    const artifact = await saveElementRequirement(dir, r, args, async () => element, signal);
    const text = await readFile(artifact.path, 'utf8');
    assert.match(text, /排除内部跟进/);
    assert.match(text, /preview-1/);
    assert.match(text, /等待源码实现/);
    assert.equal(createHash('sha256').update(text).digest('hex'), artifact.sha256);
    assert.doesNotThrow(() => assertRequirementRecorded(r));
    recordRequirementPreview(
      r,
      { ref: 'inserted', text: '下载材料' },
      {
        text: JSON.stringify({
          editId: 'preview-2',
          element: { ...element, textContent: '下载材料' },
        }),
      },
    );
    assert.equal(r.saved, undefined);
    assert.throws(() => assertRequirementRecorded(r), /先调用/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
