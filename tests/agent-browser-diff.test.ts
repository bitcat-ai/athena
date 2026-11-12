import assert from 'node:assert/strict';
import test from 'node:test';
import { diffLines } from '../src/main/agent-browser-diff';

test('snapshot diff reports only the lines that changed, in tree order', () => {
  const before = [
    '- heading "Cart"',
    '  - listitem "Tea"',
    '  - listitem "Milk"',
    '- button "Pay"',
  ];
  assert.deepEqual(diffLines(before.join('\n'), before.join('\n')), {
    text: '',
    added: 0,
    removed: 0,
    changed: false,
  });
  const after = [
    '- heading "Cart"',
    '  - listitem "Tea"',
    '  - listitem "Bread"',
    '  - listitem "Milk"',
    '- button "Pay" [disabled]',
  ];
  assert.deepEqual(diffLines(before.join('\n'), after.join('\n')), {
    text: '+   - listitem "Bread"\n- - button "Pay"\n+ - button "Pay" [disabled]',
    added: 2,
    removed: 1,
    changed: true,
  });
  assert.deepEqual(diffLines('', 'a\nb'), {
    text: '- \n+ a\n+ b',
    added: 2,
    removed: 1,
    changed: true,
  });
  // A moved line is one removal and one addition; the lines between stay untouched.
  assert.equal(diffLines('a\nb\nc\nd', 'b\nc\nd\na').text, '- a\n+ a');
  // Repeated lines are matched by position, not collapsed.
  assert.deepEqual(
    [diffLines('x\nx\nx', 'x\nx').removed, diffLines('x\nx', 'x\nx\nx').added],
    [1, 1],
  );
});

test('very large snapshots still produce a bounded, correct summary', () => {
  const before = Array.from({ length: 3000 }, (_, index) => `- row "${index}"`);
  const after = before.map((line, index) => (index % 2 ? line : line + ' [changed]'));
  const started = Date.now();
  const diff = diffLines(before.join('\n'), after.join('\n'));
  assert(Date.now() - started < 2000);
  assert.equal(diff.removed, 1500);
  assert.equal(diff.added, 1500);
  assert(diff.text.includes('- - row "0"\n'));
  assert(diff.text.includes('+ - row "2998" [changed]'));
  assert(!diff.text.includes('row "1"\n'));
  // A long shared prefix and suffix keep an otherwise huge comparison exact.
  const edited = [...before];
  edited.splice(1500, 1, '- row "replaced"');
  assert.equal(
    diffLines(before.join('\n'), edited.join('\n')).text,
    '- - row "1500"\n+ - row "replaced"',
  );
});
