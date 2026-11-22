import assert from 'node:assert/strict';
import test from 'node:test';
import { pageFacts, pageHints } from '../src/shared/page-hints';

const none = { fields: 0, password: false, tables: 0, paragraphs: 0, characters: 0, headings: 0, prices: 0 };

test('a page offers at most three things, the most specific first', () => {
  assert.deepEqual(pageHints(undefined), []);
  assert.deepEqual(pageHints(none), []);
  assert.deepEqual(
    pageHints({ ...none, fields: 5, tables: 1, prices: 4, paragraphs: 9, characters: 5000, headings: 2 }).map(
      (hint) => hint.id,
    ),
    ['form', 'table', 'prices'],
  );
  assert.deepEqual(
    pageHints({ ...none, fields: 2, password: true, headings: 1 }).map((hint) => hint.id),
    ['sign-in', 'headline'],
    'a sign-in page is guided, never filled in',
  );
  assert.deepEqual(
    pageHints({ ...none, paragraphs: 6, characters: 4000, headings: 3 }).map((hint) => hint.id),
    ['summary', 'headline'],
  );
});

test('facts from a page are counts, and anything else is discarded', () => {
  assert.equal(pageFacts('text'), undefined);
  assert.deepEqual(pageFacts({ fields: '3', tables: 2.9, password: 'yes', prices: -1, secret: 'x' }), {
    ...none,
    tables: 2,
  });
});
