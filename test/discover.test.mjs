import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupContainers, pageOf, pageCount, mergeSelection,
  containerLabel, containerDescription, GROUPS, PAGE_SIZE,
} from '../src/stock/discover.mjs';

const make = (n, origin, extra = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${origin}-${i}`, name: `${origin} ${i}`, origin, pockets: [], ...extra,
  }));

test('groupContainers buckets by origin in display order', () => {
  const groups = groupContainers([...make(2, 'house'), ...make(3, 'personal'), ...make(1, 'bank')]);
  assert.deepEqual(groups.map((g) => g.key), ['personal', 'house', 'bank']);
  assert.equal(groups.find((g) => g.key === 'house').containers.length, 2);
});

test('groupContainers drops empty groups rather than showing zeroes', () => {
  const groups = groupContainers(make(3, 'claim'));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'claim');
});

test('every origin a normalizer can emit has a display group', () => {
  // Guards the silent-drop failure: groupContainers only keeps known origins, so
  // an origin without a group would vanish from the picker without any error.
  const emitted = ['claim', 'personal', 'bank', 'deployable', 'house'];
  for (const origin of emitted) {
    assert.ok(GROUPS.some((g) => g.key === origin), `no group defined for origin "${origin}"`);
  }
});

test('groupContainers drops nothing when every origin is known', () => {
  const containers = [
    ...make(2, 'personal'), ...make(3, 'house'), ...make(1, 'deployable'),
    ...make(4, 'bank'), ...make(5, 'claim'),
  ];
  const kept = groupContainers(containers).reduce((n, g) => n + g.containers.length, 0);
  assert.equal(kept, containers.length);
});

test('pageCount never reports zero pages', () => {
  assert.equal(pageCount(0), 1);
  assert.equal(pageCount(1), 1);
  assert.equal(pageCount(25), 1);
  assert.equal(pageCount(26), 2);
  assert.equal(pageCount(35), 2);
});

test('pageOf slices a 35-container house into two pages', () => {
  const items = make(35, 'house');
  const first = pageOf(items, 0);
  assert.equal(first.pages, 2);
  assert.equal(first.items.length, PAGE_SIZE);
  const second = pageOf(items, 1);
  assert.equal(second.items.length, 10);
  assert.equal(second.items[0].id, 'house-25');
});

test('pageOf clamps out-of-range pages instead of returning nothing', () => {
  const items = make(35, 'house');
  assert.equal(pageOf(items, 99).page, 1);
  assert.equal(pageOf(items, -5).page, 0);
});

test('no select menu can exceed Discord\'s 25-option cap', () => {
  const items = make(35, 'house');
  for (let p = 0; p < pageCount(items.length); p++) {
    assert.ok(pageOf(items, p).items.length <= 25);
  }
});

test('mergeSelection keeps choices made on other pages', () => {
  // Chosen earlier on page 2, then the user edits page 1.
  const selected = new Set(['house-0', 'house-30']);
  const pageIds = ['house-0', 'house-1', 'house-2'];
  const next = mergeSelection(selected, pageIds, ['house-1', 'house-2']);
  assert.ok(next.has('house-30'), 'a selection from another page was lost');
  assert.ok(next.has('house-1'));
  assert.ok(!next.has('house-0'), 'deselecting on the current page should remove it');
});

test('mergeSelection clearing a page leaves other pages intact', () => {
  const selected = new Set(['a', 'b', 'z']);
  const next = mergeSelection(selected, ['a', 'b'], []);
  assert.deepEqual([...next], ['z']);
});

test('mergeSelection does not mutate the set it was given', () => {
  const selected = new Set(['a']);
  mergeSelection(selected, ['a'], ['b']);
  assert.deepEqual([...selected], ['a']);
});

test('containerLabel stays inside the 100-character cap', () => {
  const long = { name: 'x'.repeat(200) };
  assert.ok(containerLabel(long).length <= 100);
  assert.equal(containerLabel({ name: 'Logs' }), 'Logs');
  assert.equal(containerLabel({}), '(unnamed)');
});

test('containerDescription says where a bank container actually is', () => {
  const d = containerDescription({ origin: 'bank', claimName: 'Aurelia', pockets: [{ contents: {} }] });
  assert.match(d, /Aurelia/);
  assert.match(d, /1 stack/);
});

test('containerDescription counts only filled pockets', () => {
  const d = containerDescription({
    origin: 'house',
    pockets: [{ contents: { itemId: 1 } }, { contents: null }, { contents: { itemId: 2 } }],
  });
  assert.match(d, /2 stacks/);
});

test('containerDescription stays inside the 100-character cap', () => {
  const d = containerDescription({ origin: 'bank', claimName: 'y'.repeat(300), pockets: [] });
  assert.ok(d.length <= 100);
});
