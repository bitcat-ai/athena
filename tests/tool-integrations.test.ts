import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolIntegration } from '../src/shared/tool-integrations';
import type { ToolCall } from '../src/shared/types';

test('integration cards show returned knowledge, without exposing transfer credentials', () => {
  const call: ToolCall = {
    id: '1',
    name: 'workbench_repository_resolve',
    input: {},
    status: 'done',
    output: JSON.stringify({
      repository: 'https://example.test/crm.git',
      application: 'crm',
      module: 'customers',
      components: { frontend: { root: 'frontend' }, backend: { root: 'backend' } },
      bundleUrl: 'http://example.test/secret-token/bundle',
      uploadUrls: { frontend: 'secret' },
    }),
  };
  const card = toolIntegration(call)!;
  assert.equal(card.kind, 'mcp');
  assert(card.facts.some((fact) => fact.value === 'frontend'));
  assert(!JSON.stringify(card).includes('secret'));
  assert.deepEqual(toolIntegration({ ...call, status: 'error' })?.facts, []);
  assert.equal(toolIntegration({ ...call, name: 'neo_read' }), undefined);
});

test('a Skill is named from the actual read result and handles incomplete output', () => {
  const call: ToolCall = {
    id: '1',
    name: 'workbench_skill_read',
    input: { name: 'business-context' },
    status: 'running',
  };
  assert.equal(toolIntegration(call)?.name, 'business-context');
  assert.equal(
    toolIntegration({ ...call, status: 'done', output: '{incomplete' })?.description,
    undefined,
  );
  assert.equal(
    toolIntegration({
      ...call,
      status: 'done',
      output: JSON.stringify({ title: '业务领域核对', description: '观察页面并核对资料' }),
    })?.name,
    '业务领域核对',
  );
});
