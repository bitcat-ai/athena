import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationTitle } from '../src/shared/conversation-title.ts';

test('链接跨越标题长度边界时保留完整链接', () => {
  const url = 'https://yeepay.feishu.cn/file/Cawrb4khLobNbmxSXdecfA68nid';
  assert.equal(conversationTitle(`${url} 总结这是在干啥`), url);
  assert.equal(conversationTitle(`总结 ${url}`), `总结 ${url}`);
});

test('普通标题保持长度限制且只使用首行', () => {
  assert.equal(conversationTitle('字'.repeat(40)), '字'.repeat(32));
  assert.equal(conversationTitle('  第一行\n第二行'), '第一行');
});
