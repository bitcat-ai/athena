import assert from 'node:assert/strict';
import test from 'node:test';
import { isSelectedAppearance, selectedLayout } from '../src/main/selected-layout';

const first = { token: '[ele1]', ref: 'one', tag: 'h1', name: 'Heading' };
const second = { token: '[ele2]', ref: 'two', tag: 'p', name: 'Subtitle' };
test('only an explicit arrangement of the attached selections can run without a model', () => {
  assert.equal(selectedLayout('[ele1] 它和副标题，改为左右布局', [first], 9)?.direction, 'row');
  assert.deepEqual(selectedLayout('请将 [ele2] 与 [ele1] 改成上下排列。', [first, second], 7), {
    ref: 'two',
    otherRef: 'one',
    direction: 'column',
    revision: 7,
  });
  for (const request of [
    '[ele1] 不要和副标题改成左右布局',
    '[ele1] 和副标题改为左右布局，保存源码',
    '为什么 [ele1] 和副标题是左右布局？',
    '假如 [ele1] 和副标题改为左右布局',
    '[ele2] 和副标题改为左右布局',
  ])
    assert.equal(selectedLayout(request, [first], 1), undefined, request);
  assert.equal(
    selectedLayout('[ele1] 和副标题改为左右布局', [{ ...first, edit: { text: '另一个操作' } }], 1),
    undefined,
  );
  assert.ok(isSelectedAppearance('[ele1] 把字体改小一点'));
  assert.ok(!isSelectedAppearance('[ele1] 按项目规范修改字体并保存源码'));
});
